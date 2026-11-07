// Turns merged frame snapshots into the compact text agents read, and diffs two snapshots.
// Every token here is paid by the agent on every call, so the format is dense on purpose.

import type { FrameElement, FrameSnapshot } from '../shared/engine';

export interface MergedEl extends FrameElement {
  /** Global ref shown to agents. */
  g: number;
  frameKey: string;
}

export type MergedItem =
  | { k: 'el'; el: MergedEl }
  | { k: 'h'; level: number; text: string; inView: boolean }
  | { k: 't'; text: string; inView: boolean }
  | { k: 'frame'; label: string };

export interface MergedSnapshot {
  url: string;
  title: string;
  viewport: FrameSnapshot['viewport'];
  scroller?: string;
  dialog?: string;
  items: MergedItem[];
  total: number;
  listed: number;
  focused?: number;
  readyState: DocumentReadyState;
  frames: number;
}

const q = (s: string) => `“${s}”`;

export function shortHref(href: string, pageUrl: string): string {
  try {
    const u = new URL(href);
    const p = new URL(pageUrl);
    let s = u.origin === p.origin ? u.pathname + u.search + u.hash : u.host.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname) + u.search;
    if (s.length > 64) s = s.slice(0, 63) + '…';
    return s;
  } catch {
    return href.slice(0, 64);
  }
}

export function elLine(e: MergedEl, pageUrl: string, compact = false): string {
  const parts: string[] = [`[${e.g}]`];
  if (!compact) parts.push(e.role);
  parts.push(e.name ? q(e.name) : e.placeholder ? `(${q(e.placeholder)})` : '(no name)');
  if (e.inputType && e.inputType !== 'text' && e.inputType !== e.role) parts.push(`type=${e.inputType}`);
  if (e.value !== undefined && e.value !== '' && e.role !== 'link' && e.role !== 'button') parts.push(`= ${q(e.value)}`);
  else if (e.placeholder && e.name && e.placeholder !== e.name && !compact) parts.push(`placeholder ${q(e.placeholder)}`);
  if (e.checked !== undefined) parts.push(e.checked === 'mixed' ? 'mixed' : e.checked ? 'checked' : 'unchecked');
  if (e.pressed) parts.push('pressed');
  if (e.selected) parts.push('selected');
  if (e.expanded !== undefined) parts.push(e.expanded ? 'expanded' : 'collapsed');
  if (e.disabled) parts.push('disabled');
  if (e.required) parts.push('required');
  if (e.readonly) parts.push('readonly');
  if (e.focused) parts.push('focused');
  if (e.options && e.options.length) {
    const more = (e.optionCount ?? e.options.length) - e.options.length;
    parts.push(`options: ${e.options.join(' | ')}${more > 0 ? ` …(+${more})` : ''}`);
  }
  if (e.href && e.role === 'link' && !compact) {
    const h = shortHref(e.href, pageUrl);
    if (h && h !== '/' && !e.name.toLowerCase().includes(h.toLowerCase())) parts.push(`→ ${h}`);
  }
  return parts.join(' ');
}

function scrollLine(v: FrameSnapshot['viewport']): string {
  const max = Math.max(0, v.scrollHeight - v.height);
  if (max < 8) return 'whole page visible';
  const pct = Math.round((v.scrollY / max) * 100);
  const where = pct <= 1 ? 'top of page' : pct >= 99 ? 'bottom of page' : `scrolled ${pct}%`;
  return `${where} (${v.scrollY}/${max}px)`;
}

export function formatSnapshot(s: MergedSnapshot, opts: { query?: string } = {}): string {
  const out: string[] = [];
  out.push(`# ${s.title || '(untitled)'}`);
  const meta = [s.url, `${s.viewport.width}×${s.viewport.height}`, scrollLine(s.viewport)];
  if (s.readyState === 'loading') meta.push('still loading');
  out.push(meta.join(' · '));
  if (s.dialog) out.push(`⚠ ${s.dialog} is open and blocks the page; only its elements are listed. Close it or act inside it.`);
  if (s.scroller) out.push(`(the page scrolls inside ${s.scroller})`);
  out.push('');

  let items = s.items;
  const hits = new Set<MergedItem>();
  if (opts.query) {
    const terms = opts.query
      .toLowerCase()
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean);
    const hit = (t: string) => terms.some((x) => t.toLowerCase().includes(x));
    const isHit = (it: MergedItem) =>
      it.k === 'el'
        ? hit(it.el.name) || hit(it.el.role) || (it.el.placeholder ? hit(it.el.placeholder) : false) || (it.el.href ? hit(it.el.href) : false) || (it.el.value ? hit(it.el.value) : false)
        : it.k === 'frame'
          ? false
          : hit(it.text);
    // Keep each match with its neighbours (2 before, 5 after): a bare "140 comments" link is useless
    // without the story title next to it, a price without its "Add to cart".
    const keep = new Set<number>();
    s.items.forEach((it, i) => {
      if (!isHit(it)) return;
      hits.add(it);
      for (let j = Math.max(0, i - 2); j <= Math.min(s.items.length - 1, i + 5); j++) keep.add(j);
    });
    const chunked: MergedItem[] = [];
    let prev = -2;
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (prev >= 0 && i !== prev + 1) chunked.push({ k: 'frame', label: '…' });
      chunked.push(s.items[i]);
      prev = i;
    }
    items = chunked;
    if (!hits.size) out.push(`Nothing matches “${opts.query}”.`);
    else out.push(`${hits.size} match${hits.size > 1 ? 'es' : ''} for “${opts.query}” (marked ›, shown with their neighbours):`);
  }

  // Leading items above the viewport get a marker, then the in-view block, then below.
  let zone: 'above' | 'in' | 'below' | null = null;
  const zoneOf = (it: MergedItem): 'above' | 'in' | 'below' | null => {
    if (it.k === 'frame') return null;
    const inView = it.k === 'el' ? it.el.inView : it.inView;
    if (inView) return 'in';
    if (it.k === 'el') return it.el.rect[1] < 0 ? 'above' : 'below';
    return zone === null || zone === 'above' ? 'above' : 'below';
  };

  let compactBuf: { lm: string; parts: string[] } | null = null;
  const flushCompact = () => {
    if (compactBuf && compactBuf.parts.length) {
      for (let i = 0; i < compactBuf.parts.length; i += 6) out.push(`${compactBuf.lm}: ${compactBuf.parts.slice(i, i + 6).join('  ')}`);
    }
    compactBuf = null;
  };

  for (const it of items) {
    const z = zoneOf(it);
    if (z && z !== zone && !opts.query) {
      flushCompact();
      if (z === 'above') out.push('── above the viewport ──');
      else if (z === 'below' && zone !== null) out.push('── below the viewport ──');
      else if (z === 'in' && zone === 'above') out.push('── in view ──');
      zone = z;
    }
    if (it.k === 'frame') {
      flushCompact();
      out.push(it.label === '…' ? '…' : `── frame: ${it.label} ──`);
      continue;
    }
    const mark = opts.query ? (hits.has(it) ? '› ' : '  ') : '';
    if (it.k === 'h') {
      flushCompact();
      out.push(`${mark}${'#'.repeat(Math.min(6, it.level + 1))} ${it.text}`);
      continue;
    }
    if (it.k === 't') {
      flushCompact();
      out.push(`  ${it.text}`);
      continue;
    }
    const e = it.el;
    const lm = e.landmark ?? '';
    const compactable = !opts.query && e.role === 'link' && (lm === 'nav' || lm === 'footer' || lm.startsWith('nav ')) && e.name.length < 40;
    if (compactable) {
      if (!compactBuf || compactBuf.lm !== lm) {
        flushCompact();
        compactBuf = { lm, parts: [] };
      }
      compactBuf.parts.push(elLine(e, s.url, true));
      continue;
    }
    flushCompact();
    out.push(mark + elLine(e, s.url));
  }
  flushCompact();
  if (s.total > s.listed && !opts.query) out.push(`(${s.listed} of ${s.total} elements listed; use observe with query to find others)`);
  if (!s.items.some((i) => i.k === 'el')) out.push('(no interactive elements found)');
  return out.join('\n');
}

/** Signature of an element's state, for change detection. */
function sig(e: MergedEl) {
  return [e.role, e.name, e.value ?? '', e.checked ?? '', e.expanded ?? '', e.disabled ?? '', e.selected ?? '', e.pressed ?? ''].join('\u0001');
}

export interface Diff {
  added: MergedEl[];
  removed: MergedEl[];
  changed: { before: MergedEl; after: MergedEl }[];
}

export function diffSnapshots(a: MergedSnapshot, b: MergedSnapshot): Diff {
  const before = new Map<number, MergedEl>();
  for (const it of a.items) if (it.k === 'el') before.set(it.el.g, it.el);
  const after = new Map<number, MergedEl>();
  for (const it of b.items) if (it.k === 'el') after.set(it.el.g, it.el);
  const d: Diff = { added: [], removed: [], changed: [] };
  for (const [g, e] of after) {
    const p = before.get(g);
    if (!p) d.added.push(e);
    else if (sig(p) !== sig(e)) d.changed.push({ before: p, after: e });
  }
  for (const [g, e] of before) if (!after.has(g)) d.removed.push(e);
  return d;
}

export function diffSize(d: Diff) {
  return d.added.length + d.removed.length + d.changed.length;
}

export function formatDiff(d: Diff, pageUrl: string): string {
  const n = diffSize(d);
  if (!n) return 'No visible change to the elements on the page.';
  const out: string[] = [`Changes: ${d.added.length} new, ${d.removed.length} gone, ${d.changed.length} changed`];
  const added = [...d.added].sort((x, y) => Number(y.inView) - Number(x.inView));
  for (const e of added.slice(0, 30)) out.push(`+ ${elLine(e, pageUrl)}`);
  if (added.length > 30) out.push(`+ …${added.length - 30} more`);
  for (const c of d.changed.slice(0, 15)) out.push(`~ ${elLine(c.after, pageUrl)}`);
  if (d.removed.length) {
    const names = d.removed
      .slice(0, 12)
      .map((e) => `[${e.g}] ${e.name ? q(e.name.slice(0, 40)) : e.role}`)
      .join(', ');
    out.push(`− ${names}${d.removed.length > 12 ? ` …+${d.removed.length - 12}` : ''}`);
  }
  return out.join('\n');
}
