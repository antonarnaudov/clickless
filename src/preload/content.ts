// Preload for every web page and every frame in it. Two jobs:
//  1. the content engine the main process drives over IPC (snapshot, resolve, read, overlay…)
//  2. on clickless:// internal pages, `window.clickless` with a restricted API.
// Runs in an isolated world: page scripts cannot see or tamper with any of this.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ClicklessAPI } from '../shared/ipc';
import type { EngineMethods, RpcRequest, RpcResponse } from '../shared/engine';
import { elementFor, isEditable } from './engine/dom';
import { snapshot } from './engine/snapshot';
import { resolve } from './engine/resolve';
import { readPage } from './engine/readable';
import { clearMarks, marks, pointer, pointerHide } from './engine/overlay';
import { startAutofill } from './engine/autofill';
import { hasText, quietMs, startObserving, waitFor, watchCollect, watchStart } from './engine/watch';

const isTop = window.top === window;
const DOC_ID = Math.random().toString(36).slice(2, 10);

function el(ref: number): Element {
  const e = elementFor(ref);
  if (!e) throw new Error(`ref [${ref}] is gone (the page changed)`);
  return e;
}

const methods: { [K in keyof EngineMethods]: (p: any) => ReturnType<EngineMethods[K]> | Promise<ReturnType<EngineMethods[K]>> } = {
  ping: () => ({ url: location.href, top: isTop, quietMs: quietMs(), readyState: document.readyState, doc: DOC_ID }),
  tag: ({ ref, token }) => {
    el(ref).setAttribute('data-clickless-tag', token);
    return true;
  },
  snapshot: (p) => ({ ...snapshot(p), doc: DOC_ID }),
  resolve: (p) => {
    const r = resolve(p);
    return { ...r, doc: DOC_ID };
  },
  focus: ({ ref }) => {
    const e = el(ref) as HTMLElement;
    e.focus?.({ preventScroll: true });
    return document.activeElement === e || e.contains(document.activeElement);
  },
  selectAll: ({ ref }) => {
    const e = el(ref) as HTMLInputElement;
    e.focus?.({ preventScroll: true });
    if (typeof e.select === 'function' && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA')) {
      try {
        e.select();
      } catch {
        /* number inputs etc. */
      }
      return (e.value || '').length;
    }
    if ((e as HTMLElement).isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(e);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return (e.textContent || '').length;
    }
    return 0;
  },
  selectOption: ({ ref, values }) => {
    const s = el(ref) as HTMLSelectElement;
    if (s.tagName !== 'SELECT') {
      return { ok: false, error: 'Not a native <select>; click it and then click the option instead.', options: [] };
    }
    const opts = Array.from(s.options);
    const norm = (x: string) => x.trim().toLowerCase();
    const chosen: string[] = [];
    const picks = values.map((v: string) => {
      const n = norm(String(v));
      return (
        opts.find((o) => norm(o.label || o.text) === n || norm(o.value) === n) ??
        opts.find((o) => norm(o.label || o.text).startsWith(n)) ??
        opts.find((o) => norm(o.label || o.text).includes(n) || norm(o.value).includes(n))
      );
    });
    if (picks.some((p: HTMLOptionElement | undefined) => !p)) {
      return { ok: false, error: `Option not found: ${values.join(', ')}`, options: opts.slice(0, 40).map((o) => o.label || o.text) };
    }
    if (s.multiple) for (const o of opts) o.selected = false;
    for (const p of picks as HTMLOptionElement[]) {
      p.selected = true;
      chosen.push(p.label || p.text);
    }
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, chosen };
  },
  setValue: ({ ref, value }) => {
    const e = el(ref) as HTMLInputElement;
    if (!isEditable(e)) return false;
    if ((e as HTMLElement).isContentEditable && e.tagName !== 'INPUT' && e.tagName !== 'TEXTAREA') {
      e.textContent = value;
    } else {
      const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(e, value);
    }
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  isChecked: ({ ref }) => {
    const e = elementFor(ref) as HTMLInputElement | null;
    if (!e) return null;
    if (e.tagName === 'INPUT') return e.checked;
    const a = e.getAttribute('aria-checked') ?? e.getAttribute('aria-pressed') ?? e.getAttribute('aria-selected');
    return a === null ? null : a === 'true';
  },
  getValue: ({ ref }) => {
    const e = elementFor(ref) as HTMLInputElement | null;
    if (!e) return null;
    if (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT') return e.value;
    if ((e as HTMLElement).isContentEditable) return (e as HTMLElement).innerText;
    return null;
  },
  domClick: ({ ref }) => {
    const e = el(ref) as HTMLElement;
    e.click();
    return true;
  },
  scrollBy: ({ dx, dy, ref }) => {
    const target = ref ? el(ref) : null;
    const scroller = target ?? findScroller();
    if (scroller) scroller.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
    else window.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
    return scrollState(scroller);
  },
  scrollTo: ({ position }) => {
    const scroller = findScroller();
    const top = position === 'top' ? 0 : 1e9;
    if (scroller) scroller.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
    else window.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
    const s = scrollState(scroller);
    return { scrollY: s.scrollY, scrollHeight: s.scrollHeight };
  },
  scrollIntoView: ({ ref }) => {
    (el(ref) as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    return true;
  },
  watchStart: () => watchStart(),
  watchCollect: () => watchCollect(),
  waitFor: (p) => waitFor(p),
  hasText: ({ text }) => hasText(text),
  read: (p) => readPage(p),
  childFrames: () =>
    Array.from(document.querySelectorAll('iframe, frame')).map((f) => {
      const r = f.getBoundingClientRect();
      const cs = getComputedStyle(f);
      const bl = parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) || 0;
      const bt = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) || 0;
      return {
        name: f.getAttribute('name') || '',
        src: (f as HTMLIFrameElement).src || '',
        rect: [Math.round(r.x + bl), Math.round(r.y + bt), Math.round(r.width), Math.round(r.height)] as [number, number, number, number],
      };
    }),
  scrollChildFrame: ({ index }) => {
    const f = document.querySelectorAll('iframe, frame')[index] as HTMLElement | undefined;
    f?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
    return !!f;
  },
  viewport: () => ({ w: innerWidth, h: innerHeight }),
  pointer: (p) => pointer(p),
  pointerHide: () => pointerHide(),
  marks: (p) => marks(p.boxes),
  clearMarks: () => clearMarks(),
  evaluate: ({ code }) => {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${code})`)();
  },
  run: ({ fn }) => {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${fn})()`)();
  },
};

function findScroller(): Element | null {
  const se = document.scrollingElement || document.documentElement;
  if (se.scrollHeight > innerHeight + 4) return null;
  let n = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  while (n && n !== document.documentElement) {
    const cs = getComputedStyle(n);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 4) return n;
    n = n.parentElement;
  }
  return null;
}

function scrollState(scroller: Element | null) {
  const se = document.scrollingElement || document.documentElement;
  const y = scroller ? scroller.scrollTop : scrollY;
  const h = scroller ? scroller.scrollHeight : se.scrollHeight;
  const vh = scroller ? scroller.clientHeight : innerHeight;
  return { scrollY: Math.round(y), scrollHeight: Math.round(h), atEnd: y + vh >= h - 4, atTop: y <= 2 };
}

ipcRenderer.on(IPC.rpc, async (_e, req: RpcRequest) => {
  const res: RpcResponse = { id: req.id, ok: true };
  try {
    const fn = methods[req.method];
    if (!fn) throw new Error(`unknown method ${req.method}`);
    let result = await fn(req.params);
    // results must be structured-clonable
    if (req.method === 'evaluate' || req.method === 'run') result = JSON.parse(JSON.stringify(result ?? null));
    res.result = result;
  } catch (err) {
    res.ok = false;
    res.error = err instanceof Error ? err.message : String(err);
  }
  ipcRenderer.send(IPC.rpcResult, res);
});

// Track DOM changes from the start so "quiet" detection works on the first action.
if (document.documentElement) startObserving();
else document.addEventListener('readystatechange', () => startObserving(), { once: true });
// saved passwords on web pages (not on Clickless's own pages)
if (/^https?:$/.test(location.protocol)) startAutofill();

// ---------- internal pages ----------

if (location.protocol === 'clickless:' && isTop) {
  const sub = <T,>(channel: string, cb: (v: T) => void) => {
    const l = (_e: Electron.IpcRendererEvent, v: T) => cb(v);
    ipcRenderer.on(channel, l);
    return () => {
      ipcRenderer.removeListener(channel, l);
    };
  };
  const api: ClicklessAPI = {
    surface: 'internal',
    platform: process.platform as ClicklessAPI['platform'],
    cmd: (c) => ipcRenderer.invoke(IPC.cmd, c),
    query: (n, a) => ipcRenderer.invoke(IPC.query, n, a),
    onState: (cb) => sub(IPC.state, cb),
    onChat: (cb) => sub(IPC.chat, cb),
    onAsk: (cb) => sub(IPC.ask, cb),
    onEvent: (cb) => sub(IPC.event, cb),
  };
  contextBridge.exposeInMainWorld('clickless', api);
}
