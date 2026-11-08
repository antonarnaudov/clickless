// PageController: drives one tab. Talks to the content engine in every frame over IPC,
// sends trusted input through the Chrome DevTools Protocol, waits for pages to settle, and
// keeps global element refs stable across calls so agents can act without re-observing.

import { nativeImage, type WebContents, type WebFrameMain } from 'electron';
import { IPC } from '../shared/ipc';
import type {
  EngineMethod,
  EngineMethods,
  FrameChildRect,
  FrameSnapshot,
  ResolveFailure,
  Resolved,
  RpcRequest,
  RpcResponse,
  RpcTarget,
  WatchResult,
} from '../shared/engine';
import type { Settings } from '../shared/types';
import type { Target } from '../shared/steps';
import { formatSnapshot, type MergedEl, type MergedItem, type MergedSnapshot } from './format';
import { MOD, macCommands, parseCombo, keyDef } from './keys';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PageHost {
  settings(): Settings;
  /** The tab is on screen (cursor animation only makes sense then). */
  isVisible(): boolean;
}

export interface NavMark {
  nav: number;
  doc: number;
  stop: number;
}

interface RefInfo {
  frameKey: string;
  ftn: number;
  doc: string;
  local: number;
  role: string;
  name: string;
}

export interface Located {
  frame: WebFrameMain;
  ftn: number;
  offset: { x: number; y: number };
  res: Resolved;
  g: number;
}

type EngineResult<M extends EngineMethod> = Awaited<ReturnType<EngineMethods[M]>>;

export class PageController {
  private rpcSeq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private refByKey = new Map<string, number>();
  private refInfo = new Map<number, RefInfo>();
  private nextRef = 1;
  last: MergedSnapshot | null = null;
  lastAt = 0;
  /** Incremented on every main-frame cross-document navigation start / commit / load stop. */
  navSeq = 0;
  docSeq = 0;
  stopSeq = 0;
  private cdp = false;
  private inflight = new Map<string, number>();
  dialogLog: string[] = [];
  acting = 0;
  private fileChooserWaiters: ((backendNodeId: number) => void)[] = [];
  private lastLoadError: string | null = null;

  constructor(
    readonly wc: WebContents,
    private host: PageHost,
  ) {
    wc.ipc.on(IPC.rpcResult, (_e, res: RpcResponse) => {
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      clearTimeout(p.timer);
      if (res.ok) p.resolve(res.result);
      else p.reject(new Error(res.error || 'engine error'));
    });
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        this.navSeq++;
        this.lastLoadError = null;
      }
    });
    wc.on('did-stop-loading', () => {
      this.stopSeq++;
    });
    wc.on('did-navigate', () => {
      this.docSeq++;
      // new document: refs from the old one are meaningless
      this.refByKey.clear();
      this.refInfo.clear();
      this.nextRef = 1;
      this.last = null;
    });
    wc.on('did-fail-load', (_e, code, desc, _url, isMain) => {
      if (isMain && code !== -3) this.lastLoadError = `${desc} (${code})`;
    });
    wc.once('destroyed', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('tab closed'));
      }
      this.pending.clear();
    });
  }

  // ---------- engine RPC ----------

  call<M extends EngineMethod>(frame: WebFrameMain, method: M, params: Parameters<EngineMethods[M]>[0] | Record<string, never> = {}, timeout = 6000): Promise<EngineResult<M>> {
    const id = ++this.rpcSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`page did not answer ${method} in ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        frame.send(IPC.rpc, { id, method, params } satisfies RpcRequest);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  get main(): WebFrameMain {
    return this.wc.mainFrame;
  }

  private frames(): WebFrameMain[] {
    try {
      return this.wc.mainFrame.framesInSubtree.filter((f) => !f.detached);
    } catch {
      return [];
    }
  }

  private frameByFtn(ftn: number): WebFrameMain | null {
    return this.frames().find((f) => f.frameTreeNodeId === ftn) ?? null;
  }

  // ---------- CDP ----------

  async ensureCdp() {
    if (this.cdp) return;
    const dbg = this.wc.debugger;
    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3');
      } catch (err) {
        throw new Error(`cannot control this tab (${(err as Error).message})`);
      }
    }
    this.cdp = true;
    dbg.on('detach', () => {
      this.cdp = false;
    });
    dbg.on('message', (_e, method, params: any) => {
      switch (method) {
        case 'Network.requestWillBeSent':
          if (['XHR', 'Fetch', 'Document'].includes(params.type)) this.inflight.set(params.requestId, Date.now());
          break;
        case 'Network.loadingFinished':
        case 'Network.loadingFailed':
          this.inflight.delete(params.requestId);
          break;
        case 'Page.javascriptDialogOpening':
          this.onDialog(params);
          break;
        case 'Page.fileChooserOpened': {
          const w = this.fileChooserWaiters.shift();
          if (w) w(params.backendNodeId);
          break;
        }
      }
    });
    await Promise.all([
      this.send('Network.enable', {}),
      this.send('Page.enable', {}),
      // keep focus-dependent pages (and key events) working while the window is in the background
      this.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
    ]).catch(() => {});
  }

  /** Key events only reach a focused widget; focus the page without raising the window. */
  private focusForKeys() {
    if (!this.wc.isFocused()) this.wc.focus();
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.wc.debugger.sendCommand(method, params) as Promise<T>;
  }

  private onDialog(p: { type: string; message: string; defaultPrompt?: string }) {
    if (this.acting <= 0) return; // the user handles dialogs they trigger themselves
    const policy = this.host.settings().agent.dialogs;
    const accept = p.type === 'alert' || p.type === 'beforeunload' ? true : policy === 'accept';
    this.dialogLog.push(`${p.type}(“${p.message.slice(0, 200)}”) → ${accept ? 'accepted' : 'dismissed'}`);
    this.send('Page.handleJavaScriptDialog', { accept, promptText: p.defaultPrompt ?? '' }).catch(() => {});
  }

  private inflightCount(): number {
    const now = Date.now();
    let n = 0;
    for (const [id, t] of this.inflight) {
      if (now - t > 6000) this.inflight.delete(id); // long-poll / stuck: ignore
      else n++;
    }
    return n;
  }

  // ---------- waiting ----------

  /** Waits until the main document is parsed and its engine answers. */
  async waitReady(timeout = 15000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.wc.isDestroyed()) throw new Error('tab closed');
      try {
        const p = await this.call(this.main, 'ping', {}, 1200);
        if (p.readyState !== 'loading') return;
      } catch {
        /* engine not up yet (new document) */
      }
      await sleep(120);
    }
  }

  mark(): NavMark {
    return { nav: this.navSeq, doc: this.docSeq, stop: this.stopSeq };
  }

  /** After an action: follow a navigation if one started, then wait for DOM + network quiet. */
  async settle(kind: 'input' | 'nav' | 'light', before: NavMark, signal?: AbortSignal) {
    const start = Date.now();
    if (kind === 'input') await sleep(80);
    if (kind === 'nav') {
      // wait for the navigation to start (loadURL / history are async)
      while (this.navSeq === before.nav && this.docSeq === before.doc && Date.now() - start < 3000) {
        if (signal?.aborted) return;
        await sleep(30);
      }
    }
    const navigated = this.navSeq !== before.nav;
    if (navigated) {
      // wait for the new document to commit (or the load to end: downloads, errors, 204s)
      const t = Date.now();
      while (this.docSeq === before.doc && this.stopSeq === before.stop && Date.now() - t < 20000) {
        if (signal?.aborted || this.wc.isDestroyed()) return;
        await sleep(40);
      }
      await this.waitReady(15000);
    }
    const deadline = Date.now() + (kind === 'light' ? 1200 : navigated ? 4000 : 2500);
    while (Date.now() < deadline) {
      if (signal?.aborted) return;
      let quiet = 0;
      try {
        quiet = (await this.call(this.main, 'ping', {}, 1000)).quietMs;
      } catch {
        await sleep(100);
        continue;
      }
      const net = this.inflightCount();
      if (quiet >= 300 && net === 0) return;
      if (quiet >= 700 && net <= 2) return;
      if (quiet >= 1500) return;
      await sleep(90);
    }
  }

  loadError(): string | null {
    return this.lastLoadError;
  }

  // ---------- snapshots ----------

  /** Which iframe element (index in its parent document) each frame is, from the last frameOffsets. */
  private frameIndex = new Map<number, number>();

  /** Scrolls a frame (and the frames around it) into view in every ancestor document. */
  private async scrollFrameIntoView(f: WebFrameMain) {
    const chain: WebFrameMain[] = [];
    for (let cur: WebFrameMain | null = f; cur && cur !== this.main && cur.parent; cur = cur.parent) chain.push(cur);
    // outermost first, so inner frames are measured after their parents moved
    for (const cur of chain.reverse()) {
      const idx = this.frameIndex.get(cur.frameTreeNodeId);
      if (idx === undefined || !cur.parent) continue;
      await this.call(cur.parent, 'scrollChildFrame', { index: idx }, 1500).catch(() => false);
    }
    await sleep(60);
  }

  private async frameOffsets(frames: WebFrameMain[]): Promise<Map<number, { x: number; y: number; w: number; h: number }>> {
    const out = new Map<number, { x: number; y: number; w: number; h: number }>();
    out.set(this.main.frameTreeNodeId, { x: 0, y: 0, w: 1e6, h: 1e6 });
    const byParent = new Map<WebFrameMain, WebFrameMain[]>();
    for (const f of frames) {
      if (f === this.main || !f.parent) continue;
      const list = byParent.get(f.parent) ?? [];
      list.push(f);
      byParent.set(f.parent, list);
    }
    const visit = async (parent: WebFrameMain, depth: number) => {
      const kids = byParent.get(parent);
      if (!kids || depth > 3) return;
      const pOff = out.get(parent.frameTreeNodeId);
      if (!pOff) return;
      let rects: FrameChildRect[] = [];
      try {
        rects = await this.call(parent, 'childFrames', {}, 1500);
      } catch {
        return;
      }
      const used = new Set<number>();
      kids.forEach((k, i) => {
        let idx = k.name ? rects.findIndex((r, j) => !used.has(j) && r.name === k.name) : -1;
        if (idx < 0) idx = rects.findIndex((r, j) => !used.has(j) && r.src && r.src === k.url);
        if (idx < 0 && rects.length === kids.length) idx = i;
        if (idx < 0) return;
        used.add(idx);
        this.frameIndex.set(k.frameTreeNodeId, idx);
        const r = rects[idx].rect;
        out.set(k.frameTreeNodeId, { x: pOff.x + r[0], y: pOff.y + r[1], w: r[2], h: r[3] });
      });
      await Promise.all(kids.map((k) => visit(k, depth + 1)));
    };
    await visit(this.main, 0);
    return out;
  }

  private gref(ftn: number, doc: string, local: number, role: string, name: string): number {
    const key = `${ftn}/${doc}:${local}`;
    let g = this.refByKey.get(key);
    if (g === undefined) {
      g = this.nextRef++;
      this.refByKey.set(key, g);
    }
    this.refInfo.set(g, { frameKey: `${ftn}/${doc}`, ftn, doc, local, role, name });
    return g;
  }

  async snapshot(opts: { max?: number; text?: boolean; viewportOnly?: boolean } = {}): Promise<MergedSnapshot> {
    await this.waitReady(8000);
    const params = { max: opts.max ?? 200, text: !!opts.text, viewportOnly: !!opts.viewportOnly };
    const frames = this.frames();
    const subs = frames.filter((f) => f !== this.main);
    const [mainSnap, offsets] = await Promise.all([
      this.call(this.main, 'snapshot', params, 10000),
      subs.length ? this.frameOffsets(frames) : Promise.resolve(new Map<number, { x: number; y: number; w: number; h: number }>()),
    ]);
    const vw = mainSnap.viewport.width;
    const vh = mainSnap.viewport.height;
    const visibleSubs = subs
      .filter((f) => {
        const o = offsets.get(f.frameTreeNodeId);
        return o && o.w >= 60 && o.h >= 30 && o.x < vw + 200 && o.x + o.w > -200 && o.y + o.h > -vh * 3;
      })
      .slice(0, 8);
    const subSnaps = await Promise.all(
      visibleSubs.map((f) =>
        this.call(f, 'snapshot', { ...params, max: 80 }, 2500)
          .then((s) => ({ f, s }))
          .catch(() => null),
      ),
    );

    const items: MergedItem[] = [];
    let listed = 0;
    let focused: number | undefined;
    const push = (snap: FrameSnapshot, ftn: number, off: { x: number; y: number }) => {
      for (const it of snap.items) {
        if (it.k !== 'el') {
          if (it.k === 'h' || it.k === 't') items.push({ ...it, inView: off.x === 0 && off.y === 0 ? it.inView : it.inView && true });
          continue;
        }
        const e = it.el;
        const rect: [number, number, number, number] = [e.rect[0] + off.x, e.rect[1] + off.y, e.rect[2], e.rect[3]];
        const inView = rect[0] + rect[2] > 0 && rect[1] + rect[3] > 0 && rect[0] < vw && rect[1] < vh && e.inView;
        const g = this.gref(ftn, snap.doc, e.ref, e.role, e.name);
        const m: MergedEl = { ...e, rect, inView, g, frameKey: `${ftn}/${snap.doc}` };
        if (e.focused) focused = g;
        items.push({ k: 'el', el: m });
        listed++;
      }
    };
    push(mainSnap, this.main.frameTreeNodeId, { x: 0, y: 0 });
    let total = mainSnap.total;
    for (const r of subSnaps) {
      if (!r || !r.s.items.some((i) => i.k === 'el')) continue;
      let label = r.f.url;
      try {
        label = new URL(r.f.url).host || r.f.url;
      } catch {
        /* keep */
      }
      items.push({ k: 'frame', label });
      push(r.s, r.f.frameTreeNodeId, offsets.get(r.f.frameTreeNodeId)!);
      total += r.s.total;
    }
    const merged: MergedSnapshot = {
      url: mainSnap.url,
      title: mainSnap.title,
      viewport: mainSnap.viewport,
      scroller: mainSnap.scroller,
      dialog: mainSnap.dialog,
      items,
      total,
      listed,
      focused,
      readyState: mainSnap.readyState,
      frames: 1 + subSnaps.filter(Boolean).length,
    };
    this.last = merged;
    this.lastAt = Date.now();
    return merged;
  }

  async observeText(opts: { max?: number; text?: boolean; viewportOnly?: boolean; query?: string } = {}): Promise<string> {
    const s = await this.snapshot(opts);
    let text = formatSnapshot(s, { query: opts.query });
    const err = this.loadError();
    if (err) text = `⚠ The page failed to load: ${err}\n` + text;
    return text;
  }

  // ---------- target resolution ----------

  private toRpcTarget(t: Target): RpcTarget | { global: number } {
    if (typeof t === 'number') return { global: t };
    if (typeof t === 'object' && t && 'x' in t) return { x: Number(t.x), y: Number(t.y) };
    const s = String(t).trim();
    if (/^\[?\d+\]?$/.test(s)) return { global: Number(s.replace(/[[\]]/g, '')) };
    const xy = /^xy:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/i.exec(s);
    if (xy) return { x: Number(xy[1]), y: Number(xy[2]) };
    if (/^css[:=]/i.test(s)) return { css: s.slice(4).trim() };
    if (/^text[:=]/i.test(s)) return { text: s.slice(5).trim(), exact: true };
    return { text: s.replace(/^["“'](.*)["”']$/, '$1') };
  }

  /**
   * Like locate, but waits for elements that aren't there yet (late renders, frames still loading),
   * the way a person would wait a moment before giving up.
   */
  async locateWait(target: Target, action: string, timeoutMs = 2500, signal?: AbortSignal): Promise<Located> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await this.locate(target, action);
      } catch (err) {
        const msg = (err as Error).message;
        const retryable = /No element matching|No element matches|Nothing at|could not place the frame/.test(msg);
        if (!retryable || Date.now() > deadline || signal?.aborted) throw err;
        await sleep(250);
      }
    }
  }

  /** Finds the element in whichever frame holds it and returns a top-level click point. */
  async locate(target: Target, action: string): Promise<Located> {
    const t = this.toRpcTarget(target);
    const frames = this.frames();
    let offsets: Map<number, { x: number; y: number; w: number; h: number }> | null = null;
    const offsetOf = async (f: WebFrameMain) => {
      if (f === this.main) return { x: 0, y: 0 };
      offsets ??= await this.frameOffsets(frames);
      const o = offsets.get(f.frameTreeNodeId);
      if (!o) throw new Error('could not place the frame on screen');
      return { x: o.x, y: o.y };
    };
    const finish = async (f: WebFrameMain, res: Resolved): Promise<Located> => {
      let offset = await offsetOf(f);
      if (f !== this.main) {
        // the element is in view inside its frame, but the frame itself may be off-screen
        const vp = await this.call(this.main, 'viewport', {}, 1500).catch(() => null);
        const px = res.x + offset.x;
        const py = res.y + offset.y;
        if (vp && (px < 0 || py < 0 || px > vp.w || py > vp.h)) {
          await this.scrollFrameIntoView(f);
          offsets = null;
          offset = await offsetOf(f);
          const again = await this.call(f, 'resolve', { target: { ref: res.ref }, action }, 3000).catch(() => null);
          if (again?.ok) res = again as Resolved;
        }
      }
      const g = this.gref(f.frameTreeNodeId, res.doc, res.ref, res.role, res.name);
      return {
        frame: f,
        ftn: f.frameTreeNodeId,
        offset,
        g,
        res: { ...res, x: res.x + offset.x, y: res.y + offset.y, rect: [res.rect[0] + offset.x, res.rect[1] + offset.y, res.rect[2], res.rect[3]] },
      };
    };

    if ('global' in t) {
      const info = this.refInfo.get(t.global);
      if (!info) throw new Error(`[${t.global}] is not a ref on this page. Refs come from the latest observe/act output; you can also target by visible text.`);
      const f = this.frameByFtn(info.ftn);
      if (!f) throw new Error(`[${t.global}] was in a frame that is gone. Target it by text instead.`);
      const ping = await this.call(f, 'ping', {}, 1500).catch(() => null);
      const sameDoc = ping?.doc === info.doc;
      const r = sameDoc
        ? await this.call(f, 'resolve', { target: { ref: info.local }, action, fallbackName: info.name, fallbackRole: info.role }, 4000)
        : await this.call(f, 'resolve', { target: { text: info.name, exact: true }, action }, 4000);
      if (!r.ok) throw resolveError(r, `[${t.global}] ${info.role} “${info.name}”`, (l, ro, n) => this.gref(f.frameTreeNodeId, (r as ResolveFailure).doc ?? info.doc, l, ro, n));
      return finish(f, r as Resolved);
    }

    if ('x' in t) {
      const r = await this.call(this.main, 'resolve', { target: t, action, scroll: false }, 3000);
      if (!r.ok) throw resolveError(r);
      // keep the exact coordinates the agent asked for
      const loc = await finish(this.main, r as Resolved);
      loc.res.x = t.x;
      loc.res.y = t.y;
      return loc;
    }

    // text / css: main frame first, then the other frames
    const first = await this.call(this.main, 'resolve', { target: t, action }, 5000).catch((e) => ({ ok: false, error: String(e.message ?? e) }) as ResolveFailure);
    if (first.ok) return finish(this.main, first as Resolved);
    const subs = frames.filter((f) => f !== this.main).slice(0, 10);
    if (subs.length) {
      const others = await Promise.all(subs.map((f) => this.call(f, 'resolve', { target: t, action }, 2500).then((r) => ({ f, r })).catch(() => null)));
      const hit = others.find((o) => o && o.r.ok);
      if (hit) return finish(hit.f, hit.r as Resolved);
    }
    const fail = first as ResolveFailure;
    throw resolveError(fail, undefined, fail.doc ? (l, ro, n) => this.gref(this.main.frameTreeNodeId, fail.doc!, l, ro, n) : undefined);
  }

  // ---------- input ----------

  private async animate(loc: Located, label: string, click: boolean) {
    const s = this.host.settings().agent;
    if (!s.showCursor || !this.host.isVisible()) return;
    await this.call(this.main, 'pointer', { x: loc.res.x, y: loc.res.y, label, rect: loc.res.rect, ms: s.cursorMs, click }, 3000).catch(() => {});
  }

  async click(loc: Located, opts: { label: string; button?: 'left' | 'right' | 'middle'; count?: number; modifiers?: number }) {
    await this.ensureCdp();
    const vp = await this.call(this.main, 'viewport', {}, 1500).catch(() => null);
    if (vp && (loc.res.x < 0 || loc.res.y < 0 || loc.res.x > vp.w || loc.res.y > vp.h))
      throw new Error(`${opts.label} is outside the visible page (at ${Math.round(loc.res.x)},${Math.round(loc.res.y)} in a ${vp.w}×${vp.h} view); scroll to it first`);
    await this.animate(loc, opts.label, true);
    const { x, y } = loc.res;
    const button = opts.button ?? 'left';
    const modifiers = opts.modifiers ?? 0;
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    const count = opts.count ?? 1;
    for (let i = 1; i <= count; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: i, modifiers });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, modifiers });
    }
  }

  async hover(loc: Located, label: string) {
    await this.ensureCdp();
    await this.animate(loc, label, false);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.res.x, y: loc.res.y });
  }

  async insertText(text: string) {
    await this.ensureCdp();
    await this.send('Input.insertText', { text });
  }

  async typeSlowly(text: string) {
    await this.ensureCdp();
    this.focusForKeys();
    for (const ch of text) {
      if (ch === '\n') {
        await this.press('Enter');
        continue;
      }
      const def = keyDef(ch);
      const base = { key: ch, code: def?.code ?? '', windowsVirtualKeyCode: def?.keyCode ?? 0, text: ch, unmodifiedText: ch };
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: base.code, windowsVirtualKeyCode: base.windowsVirtualKeyCode });
      await sleep(12 + Math.random() * 25);
    }
  }

  async press(combo: string, times = 1) {
    await this.ensureCdp();
    this.focusForKeys();
    const c = parseCombo(combo, process.platform);
    const commands = process.platform === 'darwin' ? macCommands(c) : undefined;
    for (let i = 0; i < Math.max(1, Math.min(times, 50)); i++) {
      for (const m of c.modNames) {
        const d = keyDef(m === 'Meta' ? 'Meta' : m) ?? { key: m, code: `${m}Left`, keyCode: { Alt: 18, Control: 17, Meta: 91, Shift: 16 }[m] };
        await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: m, code: `${m === 'Meta' ? 'Meta' : m}Left`, windowsVirtualKeyCode: d.keyCode || { Alt: 18, Control: 17, Meta: 91, Shift: 16 }[m], modifiers: c.mods });
      }
      const printable = !!c.key.text && !(c.mods & (MOD.Control | MOD.Meta | MOD.Alt));
      const text = printable ? (c.mods & MOD.Shift && c.key.text!.length === 1 ? c.key.text!.toUpperCase() : c.key.text) : undefined;
      await this.send('Input.dispatchKeyEvent', {
        type: printable ? 'keyDown' : 'rawKeyDown',
        key: c.key.key,
        code: c.key.code,
        windowsVirtualKeyCode: c.key.keyCode,
        nativeVirtualKeyCode: c.key.keyCode,
        modifiers: c.mods,
        text,
        unmodifiedText: text,
        commands,
      });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: c.key.key, code: c.key.code, windowsVirtualKeyCode: c.key.keyCode, modifiers: c.mods });
      for (const m of [...c.modNames].reverse()) {
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: m, code: `${m}Left`, windowsVirtualKeyCode: { Alt: 18, Control: 17, Meta: 91, Shift: 16 }[m], modifiers: 0 });
      }
    }
  }

  /** Clicks a file input (intercepting the native picker) and sets files on it. */
  async upload(loc: Located, files: string[], label: string) {
    await this.ensureCdp();
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true });
    try {
      const chosen = new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no file picker opened; is this a file input?')), 4000);
        this.fileChooserWaiters.push((id) => {
          clearTimeout(t);
          resolve(id);
        });
      });
      if (loc.res.isFileInput && loc.frame === this.main) {
        // hidden inputs can't be clicked: find it through the DOM domain instead
        const token = Math.random().toString(36).slice(2);
        await this.call(loc.frame, 'tag', { ref: loc.res.ref, token }, 2000);
        const { root } = await this.send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-clickless-tag="${token}"]` });
        if (nodeId) {
          this.fileChooserWaiters.pop();
          await this.send('DOM.setFileInputFiles', { files, nodeId });
          return;
        }
      }
      await this.click(loc, { label });
      const backendNodeId = await chosen;
      await this.send('DOM.setFileInputFiles', { files, backendNodeId });
    } finally {
      this.fileChooserWaiters = [];
      await this.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
    }
  }

  /** Child frames worth reading (not blank, not ad/tracker frames). */
  childFrames(): WebFrameMain[] {
    return this.frames().filter((f) => f !== this.main && /^https?:/.test(f.url) && !/doubleclick|googlesyndication|adservice|amazon-adsystem|facebook\.com\/plugins|recaptcha/.test(f.url));
  }

  // every frame watches: a form inside an iframe shows its confirmation there
  async watchStart() {
    await Promise.all([this.main, ...this.childFrames()].map((f) => this.call(f, 'watchStart', {}, 1500).catch(() => {})));
  }

  async watchCollect(): Promise<WatchResult | null> {
    const all = await Promise.all([this.main, ...this.childFrames()].map((f) => this.call(f, 'watchCollect', {}, 2500).catch(() => null)));
    const main = all[0];
    if (!main) return null;
    for (const r of all.slice(1)) {
      if (!r) continue;
      for (const t of r.added) if (!main.added.includes(t) && main.added.length < 16) main.added.push(t);
      for (const t of r.alerts) if (!main.alerts.includes(t)) main.alerts.push(t);
      main.mutations += r.mutations;
      main.quietMs = Math.min(main.quietMs, r.quietMs);
    }
    return main;
  }

  // ---------- capture ----------

  async capture(opts: { marks?: boolean; fullPage?: boolean; clip?: [number, number, number, number]; maxWidth?: number; format?: 'png' | 'jpeg' } = {}): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg'; width: number; height: number }> {
    await this.ensureCdp();
    let marked = false;
    if (opts.marks) {
      const snap = await this.snapshot({ viewportOnly: true, max: 150 });
      const boxes = snap.items.filter((i): i is { k: 'el'; el: MergedEl } => i.k === 'el' && i.el.inView).map((i) => ({ n: i.el.g, rect: i.el.rect }));
      marked = await this.call(this.main, 'marks', { boxes }, 2000).catch(() => false);
      await sleep(60);
    }
    try {
      const format = opts.format ?? 'jpeg';
      const params: Record<string, unknown> = { format, captureBeyondViewport: !!opts.fullPage, optimizeForSpeed: true };
      if (format === 'jpeg') params.quality = 72;
      if (opts.fullPage) {
        const m = await this.send('Page.getLayoutMetrics');
        const cs = m.cssContentSize ?? m.contentSize;
        params.clip = { x: 0, y: 0, width: Math.min(cs.width, 2400), height: Math.min(cs.height, 12000), scale: 1 };
      } else if (opts.clip) {
        const [x, y, w, h] = opts.clip;
        params.clip = { x: Math.max(0, x - 4), y: Math.max(0, y - 4), width: w + 8, height: h + 8, scale: 1 };
      }
      let buf: Buffer;
      try {
        const r = await this.send<{ data: string }>('Page.captureScreenshot', params);
        buf = Buffer.from(r.data, 'base64');
      } catch {
        const img = await this.wc.capturePage();
        buf = format === 'png' ? img.toPNG() : img.toJPEG(72);
      }
      let img = nativeImage.createFromBuffer(buf);
      const maxW = opts.maxWidth ?? 1280;
      const size = img.getSize();
      if (size.width > maxW) img = img.resize({ width: maxW, quality: 'good' });
      const out = format === 'png' ? img.toPNG() : img.toJPEG(72);
      const s2 = img.getSize();
      return { data: out.toString('base64'), mimeType: format === 'png' ? 'image/png' : 'image/jpeg', width: s2.width, height: s2.height };
    } finally {
      if (marked) await this.call(this.main, 'clearMarks', {}, 1000).catch(() => {});
    }
  }

  /** Evaluates JS in the page's own world (sees page variables). */
  async evaluate(code: string): Promise<unknown> {
    const trimmed = code.trim();
    const isFn = /^(async\s+)?(function\b|\([^)]*\)\s*=>|[a-zA-Z_$][\w$]*\s*=>)/.test(trimmed);
    const src = isFn ? `(${trimmed})()` : trimmed;
    return this.wc.mainFrame.executeJavaScript(src, true);
  }
}

function resolveError(r: ResolveFailure | { ok: false; error: string }, what?: string, globalRef?: (local: number, role: string, name: string) => number): Error {
  let msg = r.error;
  if (what && !msg.includes(what)) msg = `${what}: ${msg}`;
  const sug = (r as ResolveFailure).suggestions;
  if (sug && sug.length) {
    const list = sug.map((x) => `[${globalRef ? globalRef(x.ref, x.role, x.name) : x.ref}] ${x.role} “${x.name}”`);
    msg += ` Similar: ${list.join(', ')}`;
  }
  return new Error(msg);
}
