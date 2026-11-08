// Runs a batch of steps against a tab and reports, in one compact text, what each step did
// and what changed on the page — so the agent rarely needs a second call to "look".

import { describeStep, type Step, type Target } from '../shared/steps';
import type { ActOptions, ImageData, ToolResult } from './contracts';
import { diffSize, diffSnapshots, formatDiff, formatSnapshot, type MergedSnapshot } from './format';
import { MOD } from './keys';
import type { Located, PageController } from './page';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ActHost {
  controller(tabId: string): Promise<PageController>;
  activeTabId(): string | null;
  openTab(url: string, opts: { background?: boolean; openerTabId?: string }): Promise<string>;
  activateTab(tabId: string): void;
  closeTab(tabId: string): void;
  tabLabel(tabId: string): string;
  toUrl(input: string): string;
  /** Tabs the page itself opened (target=_blank, window.open) since `since`. */
  openedBy(tabId: string, since: number): string[];
  setLabel(label: string, tabId: string): void;
  assertNotPaused(): void;
}

const q = (s: string) => `“${s.length > 60 ? s.slice(0, 59) + '…' : s}”`;
const what = (loc: Located) => `${loc.res.role} ${loc.res.name ? q(loc.res.name) : '(no name)'} [${loc.g}]`;

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return ['true', 'yes', 'on', '1', 'checked', 'check'].includes(String(v).trim().toLowerCase());
}

function modsOf(step: Step): number {
  let m = 0;
  for (const k of step.modifiers ?? []) m |= MOD[k] ?? 0;
  return m;
}

interface RunCtx {
  host: ActHost;
  tabId: string;
  ctl: PageController;
  signal?: AbortSignal;
  notes: string[];
}

async function clickLike(c: RunCtx, target: Target, action: string, label: string, opts: { button?: 'left' | 'right'; count?: number; modifiers?: number } = {}): Promise<string> {
  const loc = await c.ctl.locateWait(target, action);
  if (loc.res.disabled) throw new Error(`${what(loc)} is disabled`);
  if (loc.res.obscuredBy) {
    // Something sits on top of it (sticky header, overlay). A synthetic click still reaches it.
    await c.ctl.call(loc.frame, 'domClick', { ref: loc.res.ref }, 3000);
    return `${label.split(' ')[0]} ${what(loc)} (it was covered by ${loc.res.obscuredBy}; used a direct click)`;
  }
  await c.ctl.click(loc, { label, ...opts });
  const extra = loc.res.matches > 1 && loc.res.via === 'text' ? ` (${loc.res.matches} matches, used the best one)` : loc.res.via === 'stale-ref→text' ? ' (ref was stale, found it again by name)' : '';
  return `${label.split(' ')[0]} ${what(loc)}${extra}`;
}

const SET_DIRECTLY = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
const norm = (v: string) => v.replace(/\s+/g, ' ').trim();

async function typeInto(c: RunCtx, target: Target | undefined, text: string, opts: { clear?: boolean; slowly?: boolean; submit?: boolean }): Promise<string> {
  let desc = 'the focused element';
  let loc: Located | null = null;
  let note = '';
  if (target !== undefined) {
    loc = await c.ctl.locateWait(target, 'type', 2500, c.signal);
    if (!loc.res.editable && loc.res.role !== 'combobox' && loc.res.role !== 'clickable') {
      if (loc.res.isSelect) throw new Error(`${what(loc)} is a dropdown; use select`);
      if (loc.res.isCheckable) throw new Error(`${what(loc)} is a checkbox; use check/uncheck`);
    }
    if (loc.res.disabled) throw new Error(`${what(loc)} is disabled`);
    desc = what(loc);
    if (loc.res.inputType && SET_DIRECTLY.has(loc.res.inputType)) {
      // pickers (date, time, colour, range) don't take typed text reliably: set the value
      await c.ctl.hover(loc, `Set ${q(text)}`).catch(() => {});
      const ok = await c.ctl.call(loc.frame, 'setValue', { ref: loc.res.ref, value: text }, 2000);
      const now = await c.ctl.call(loc.frame, 'getValue', { ref: loc.res.ref }, 1500).catch(() => null);
      if (!ok || (now !== null && now !== text)) throw new Error(`${desc} did not accept “${text}” (it shows “${now ?? ''}”). Use the format the field expects, e.g. 19:30 or 2026-11-07.`);
      if (opts.submit) await c.ctl.press('Enter');
      return `Set ${desc} to ${q(text)}${opts.submit ? ' and pressed Enter' : ''}`;
    }
    await c.ctl.click(loc, { label: `Type ${q(text.length > 30 ? text.slice(0, 29) + '…' : text)}` });
    if (opts.clear !== false) {
      const len = await c.ctl.call(loc.frame, 'selectAll', { ref: loc.res.ref }, 2000).catch(() => 0);
      if (len && !text) await c.ctl.press('Backspace');
    }
  }
  if (text) {
    if (opts.slowly) await c.ctl.typeSlowly(text);
    else await c.ctl.insertText(text);
  }
  if (loc && text && opts.clear !== false && !opts.slowly) {
    // verify, and repair fields that ignored the inserted text
    const now = await c.ctl.call(loc.frame, 'getValue', { ref: loc.res.ref }, 1500).catch(() => null);
    if (now !== null && norm(now) !== norm(text) && loc.res.inputType !== 'password') {
      await c.ctl.call(loc.frame, 'setValue', { ref: loc.res.ref, value: text }, 1500).catch(() => false);
      const again = await c.ctl.call(loc.frame, 'getValue', { ref: loc.res.ref }, 1500).catch(() => null);
      if (again !== null && norm(again) !== norm(text)) note = ` (the field now shows “${again.slice(0, 60)}”; it may format or limit input)`;
    }
  }
  if (opts.submit) {
    await sleep(40);
    await c.ctl.press('Enter');
  }
  const shown = /password/i.test(desc) || loc?.res.inputType === 'password' ? '•'.repeat(Math.min(8, text.length)) : text.length > 50 ? text.slice(0, 49) + '…' : text;
  return `Typed ${q(shown)} into ${desc}${opts.submit ? ' and pressed Enter' : ''}${note}`;
}

async function runStep(c: RunCtx, step: Step): Promise<{ text: string; settle: 'input' | 'nav' | 'light' | 'none' }> {
  const ctl = c.ctl;
  switch (step.action) {
    case 'click':
      return { text: await clickLike(c, step.target!, 'click', describeStep(step), { modifiers: modsOf(step) }), settle: 'input' };
    case 'dblclick':
      return { text: await clickLike(c, step.target!, 'dblclick', describeStep(step), { count: 2 }), settle: 'input' };
    case 'rightclick':
      return { text: await clickLike(c, step.target!, 'click', describeStep(step), { button: 'right' }), settle: 'input' };
    case 'hover': {
      const loc = await ctl.locateWait(step.target!, 'hover');
      await ctl.hover(loc, describeStep(step));
      return { text: `Hovered ${what(loc)}`, settle: 'light' };
    }
    case 'focus': {
      const loc = await ctl.locateWait(step.target!, 'focus');
      await ctl.call(loc.frame, 'focus', { ref: loc.res.ref }, 2000);
      return { text: `Focused ${what(loc)}`, settle: 'none' };
    }
    case 'type':
      return { text: await typeInto(c, step.target, step.text ?? '', step), settle: step.submit ? 'input' : 'light' };
    case 'fill': {
      const done: string[] = [];
      for (const [key, value] of Object.entries(step.fields ?? {})) {
        const target: Target = /^\[?\d+\]?$/.test(key.trim()) ? Number(key.replace(/[[\]]/g, '')) : key;
        const loc = await ctl.locateWait(target, 'fill', 2500, c.signal).catch((e) => {
          throw new Error(`field ${q(key)}: ${e.message}`);
        });
        if (loc.res.isSelect) {
          const r = await ctl.call(loc.frame, 'selectOption', { ref: loc.res.ref, values: [String(value)] }, 3000);
          if (!r.ok) throw new Error(`${what(loc)}: ${r.error}. Options: ${r.options.slice(0, 15).join(' | ')}`);
          done.push(`${what(loc)} = ${q(r.chosen.join(', '))}`);
        } else if (loc.res.isCheckable) {
          const want = truthy(value);
          if (loc.res.checked !== want) await ctl.click(loc, { label: want ? 'Check' : 'Uncheck' });
          done.push(`${what(loc)} ${want ? 'checked' : 'unchecked'}`);
        } else if (loc.res.isFileInput) {
          await ctl.upload(loc, [String(value)], 'Upload');
          done.push(`${what(loc)} ← ${String(value)}`);
        } else {
          const r = await typeInto(c, loc.g, String(value), { clear: true });
          done.push(r.replace(/^Typed /, ''));
        }
      }
      if (step.submit) await ctl.press('Enter');
      return { text: `Filled ${done.join('; ')}${step.submit ? '; pressed Enter' : ''}`, settle: step.submit ? 'input' : 'light' };
    }
    case 'select': {
      const loc = await ctl.locateWait(step.target!, 'select');
      const values = Array.isArray(step.value) ? step.value.map(String) : [String(step.value ?? '')];
      if (loc.res.isSelect) {
        await ctl.hover(loc, describeStep(step)).catch(() => {});
        const r = await ctl.call(loc.frame, 'selectOption', { ref: loc.res.ref, values }, 3000);
        if (!r.ok) throw new Error(`${r.error}. Options: ${r.options.slice(0, 20).join(' | ')}`);
        return { text: `Selected ${q(r.chosen.join(', '))} in ${what(loc)}`, settle: 'light' };
      }
      // custom dropdown: open it, then click the option by its text
      await ctl.click(loc, { label: `Open ${loc.res.name || 'dropdown'}` });
      await ctl.settle('light', ctl.mark(), c.signal);
      const picked: string[] = [];
      for (const v of values) {
        const opt = await ctl.locateWait(v, 'click');
        await ctl.click(opt, { label: `Choose ${q(v)}` });
        picked.push(opt.res.name || v);
      }
      return { text: `Opened ${what(loc)} and chose ${picked.map(q).join(', ')}`, settle: 'input' };
    }
    case 'check':
    case 'uncheck': {
      const want = step.action === 'check' ? (step.value === undefined ? true : truthy(step.value)) : false;
      const loc = await ctl.locateWait(step.target!, step.action);
      if (loc.res.checked === want) return { text: `${what(loc)} was already ${want ? 'checked' : 'unchecked'}`, settle: 'none' };
      await ctl.click(loc, { label: describeStep(step) });
      await sleep(60);
      const now = await ctl.call(loc.frame, 'isChecked', { ref: loc.res.ref }, 1500).catch(() => null);
      if (now !== null && now !== want) {
        await ctl.call(loc.frame, 'domClick', { ref: loc.res.ref }, 1500).catch(() => {});
      }
      return { text: `${want ? 'Checked' : 'Unchecked'} ${what(loc)}`, settle: 'light' };
    }
    case 'press': {
      await ctl.press(step.key!, step.times ?? 1);
      const isNavKey = /enter|return/i.test(step.key!);
      return { text: `Pressed ${step.key}${step.times && step.times > 1 ? ` ×${step.times}` : ''}`, settle: isNavKey ? 'input' : 'light' };
    }
    case 'scroll': {
      if (step.target !== undefined) {
        const loc = await ctl.locateWait(step.target, 'scroll');
        await ctl.hover(loc, describeStep(step)).catch(() => {});
        return { text: `Scrolled to ${what(loc)}`, settle: 'light' };
      }
      const dir = step.direction ?? 'down';
      if (dir === 'top' || dir === 'bottom') {
        const r = await ctl.call(ctl.main, 'scrollTo', { position: dir }, 3000);
        return { text: `Scrolled to the ${dir} (y=${r.scrollY} of ${r.scrollHeight})`, settle: 'light' };
      }
      const vh = ctl.last?.viewport.height ?? 800;
      const vw = ctl.last?.viewport.width ?? 1200;
      const amt = step.amount === undefined ? 0.8 : step.amount;
      const px = amt <= 10 ? Math.round(amt * (dir === 'left' || dir === 'right' ? vw : vh)) : amt;
      const dx = dir === 'left' ? -px : dir === 'right' ? px : 0;
      const dy = dir === 'up' ? -px : dir === 'down' ? px : 0;
      const r = await ctl.call(ctl.main, 'scrollBy', { dx, dy }, 3000);
      const pct = r.scrollHeight > vh ? Math.round((r.scrollY / Math.max(1, r.scrollHeight - vh)) * 100) : 100;
      return { text: `Scrolled ${dir} ${px}px → ${pct}%${r.atEnd ? ' (reached the end)' : r.atTop ? ' (at the top)' : ''}`, settle: 'light' };
    }
    case 'goto': {
      const url = c.host.toUrl(step.url!);
      ctl.wc.loadURL(url).catch(() => {});
      return { text: `Opened ${url}`, settle: 'nav' };
    }
    case 'back':
      if (!ctl.wc.navigationHistory.canGoBack()) throw new Error('no page to go back to');
      ctl.wc.navigationHistory.goBack();
      return { text: 'Went back', settle: 'nav' };
    case 'forward':
      if (!ctl.wc.navigationHistory.canGoForward()) throw new Error('no page to go forward to');
      ctl.wc.navigationHistory.goForward();
      return { text: 'Went forward', settle: 'nav' };
    case 'reload':
      ctl.wc.reload();
      return { text: 'Reloaded', settle: 'nav' };
    case 'wait': {
      const timeout = Math.min(step.timeout ?? 10000, 60000);
      if (step.text || step.gone || step.selector) {
        const r = await ctl.call(ctl.main, 'waitFor', { text: step.text, gone: step.gone, selector: step.selector, timeout }, timeout + 2000);
        if (!r.ok) throw new Error(`${describeStep(step)} timed out after ${timeout}ms`);
        return { text: `${describeStep(step)}: ok after ${r.ms}ms`, settle: 'light' };
      }
      if (step.urlIncludes) {
        const t0 = Date.now();
        while (!ctl.wc.getURL().includes(step.urlIncludes)) {
          if (Date.now() - t0 > timeout) throw new Error(`URL did not contain “${step.urlIncludes}” within ${timeout}ms (now ${ctl.wc.getURL()})`);
          await sleep(150);
        }
        return { text: `URL now ${ctl.wc.getURL()}`, settle: 'light' };
      }
      const ms = Math.min(step.ms ?? 1000, 30000);
      await sleep(ms);
      return { text: `Waited ${ms}ms`, settle: 'none' };
    }
    case 'upload': {
      const loc = await ctl.locateWait(step.target!, 'upload');
      await ctl.upload(loc, step.files ?? [], describeStep(step));
      return { text: `Attached ${(step.files ?? []).map((f) => f.split('/').pop()).join(', ')} to ${what(loc)}`, settle: 'light' };
    }
    case 'newtab': {
      const id = await c.host.openTab(step.url ? c.host.toUrl(step.url) : 'clickless://newtab', { openerTabId: c.tabId });
      c.tabId = id;
      c.ctl = await c.host.controller(id);
      return { text: `Opened new tab ${id}${step.url ? ` with ${step.url}` : ''}`, settle: 'nav' };
    }
    case 'switchtab': {
      const id = step.tab ?? '';
      c.host.activateTab(id);
      c.tabId = id;
      c.ctl = await c.host.controller(id);
      return { text: `Switched to tab ${id} ${c.host.tabLabel(id)}`, settle: 'none' };
    }
    case 'closetab': {
      const id = step.tab ?? c.tabId;
      c.host.closeTab(id);
      const next = c.host.activeTabId();
      if (id === c.tabId && next) {
        c.tabId = next;
        c.ctl = await c.host.controller(next);
      }
      return { text: `Closed tab ${id}`, settle: 'none' };
    }
  }
}

export async function runAct(host: ActHost, tabId: string, steps: Step[], opts: ActOptions = {}): Promise<ToolResult> {
  if (!steps.length) return { text: 'No steps given. Pass steps: [{"action":"click","target":"Sign in"}, …] or script: \'click "Sign in"\'.', isError: true };
  const startCtl = await host.controller(tabId);
  const c: RunCtx = { host, tabId, ctl: startCtl, signal: opts.signal, notes: [] };
  const startUrl = startCtl.wc.getURL();
  const startNav = startCtl.navSeq;
  const before: MergedSnapshot | null = startCtl.last && Date.now() - startCtl.lastAt < 120000 && startCtl.last.url === startUrl ? startCtl.last : null;
  const lines: string[] = [];
  let failed = false;
  startCtl.dialogLog = [];
  startCtl.acting++;
  const t0 = Date.now();
  await startCtl.watchStart();
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (opts.signal?.aborted) {
        lines.push(`■ Stopped by the user before step ${i + 1}.`);
        failed = true;
        break;
      }
      host.assertNotPaused();
      host.setLabel(describeStep(step), c.tabId);
      const ctl = c.ctl;
      const before = ctl.mark();
      const stepStart = Date.now();
      try {
        const r = await runStep(c, step);
        if (r.settle !== 'none') await c.ctl.settle(r.settle, c.ctl === ctl ? before : { nav: -1, doc: -1, stop: -1 }, opts.signal);
        lines.push(`✓ ${i + 1}. ${r.text}`);
        // a click that opened a tab: follow it, like a person would
        const opened = host.openedBy(c.tabId, stepStart);
        if (opened.length) {
          const id = opened[opened.length - 1];
          const from = c.tabId;
          c.tabId = id;
          c.ctl = await host.controller(id);
          await c.ctl.waitReady(10000).catch(() => {});
          lines.push(`  → the page opened a new tab ${id} ${host.tabLabel(id)}; continuing there. To go back to the page you came from: switchtab ${from}`);
        }
      } catch (err) {
        failed = true;
        lines.push(`✗ ${i + 1}. ${describeStep(step)} — ${(err as Error).message}`);
        if (!opts.continueOnError) {
          if (i < steps.length - 1) lines.push(`(skipped ${steps.length - i - 1} remaining step${steps.length - i - 1 > 1 ? 's' : ''})`);
          break;
        }
      }
    }
  } finally {
    startCtl.acting--;
  }

  const ctl = c.ctl;
  const watch = ctl === startCtl ? await ctl.watchCollect() : null;
  const after = await ctl.snapshot({}).catch(() => null);
  const out: string[] = [...lines, ''];
  const navigated = ctl !== startCtl || ctl.navSeq !== startNav;
  if (after) {
    out.push(`Now: ${q(after.title || '(untitled)')} — ${after.url}${navigated ? ' (new page)' : ''} · tab ${c.tabId} · ${Date.now() - t0}ms`);
  }
  const err = ctl.loadError();
  if (err) out.push(`⚠ Page failed to load: ${err}`);
  if (startCtl.dialogLog.length) out.push(`Dialogs: ${startCtl.dialogLog.join('; ')}`);
  if (watch) {
    if (watch.alerts.length) out.push(`Alerts: ${watch.alerts.map(q).join(' · ')}`);
    if (!navigated && watch.added.length) {
      let budget = 700;
      const texts: string[] = [];
      for (const t of watch.added) {
        if (budget <= 0) break;
        texts.push(q(t.slice(0, budget)));
        budget -= t.length;
      }
      out.push(`New text: ${texts.join(' · ')}`);
    }
  }
  const images: ImageData[] = [];
  if (after) {
    const mode = opts.observe ?? 'auto';
    if (mode !== 'never') {
      if (mode === 'always' || navigated || !before) {
        out.push('', formatSnapshot(after));
        if (after.listed < 6) {
          // little to click: the content is probably what the agent wants (JSON, a message, an article)
          const r = await ctl.call(ctl.main, 'read', { mode: 'full', links: false }, 8000).catch(() => null);
          if (r?.markdown) {
            const md = r.markdown.length > 3000 ? r.markdown.slice(0, 3000) + `\n…(${r.markdown.length - 3000} more characters: use read)` : r.markdown;
            out.push('', '## Page text', md);
          }
        }
      } else {
        const d = diffSnapshots(before, after);
        if (diffSize(d) > 40) out.push('', formatSnapshot(after));
        else out.push(formatDiff(d, after.url));
      }
    }
  }
  if (opts.screenshot) {
    try {
      const shot = await ctl.capture({});
      images.push({ data: shot.data, mimeType: shot.mimeType });
    } catch {
      /* ignore */
    }
  }
  return { text: out.join('\n').trim(), images: images.length ? images : undefined, isError: failed && lines.every((l) => !l.startsWith('✓')), data: { tabId: c.tabId, url: after?.url, failed } };
}
