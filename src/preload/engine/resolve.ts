// Finds the element an agent means: by ref, by visible text/label, by CSS or by coordinates,
// scrolls it into view and returns a click point that is not covered by something else.

import type { ResolveFailure, ResolveParams, Resolved } from '../../shared/engine';
import { accessibleName, clean, describeEl, elementFor, isEditable, rectOf, refFor, roleOf } from './dom';
import { candidates, labelFor } from './snapshot';

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[“”"'’‘`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'date', 'time']);
const CHECK_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

function roleBonus(action: string, role: string): number {
  if (action === 'type' || action === 'fill') return TEXT_ROLES.has(role) ? 30 : role === 'clickable' ? -10 : -25;
  if (action === 'check' || action === 'uncheck') return CHECK_ROLES.has(role) ? 30 : role === 'label' ? 10 : -10;
  if (action === 'select') return role === 'combobox' || role === 'listbox' ? 30 : -10;
  if (action === 'upload') return role === 'file' ? 40 : -20;
  if (action === 'click' || action === 'dblclick') {
    if (role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem' || role === 'option') return 10;
    if (TEXT_ROLES.has(role)) return -5;
  }
  return 0;
}

function matchScore(name: string, q: string): number {
  if (!name) return 0;
  const n = norm(name);
  if (n === q) return 100;
  if (n.startsWith(q)) return 75 - Math.min(20, (n.length - q.length) / 4);
  if (n.includes(q)) return 60 - Math.min(20, (n.length - q.length) / 6);
  // all query words present
  const words = q.split(' ').filter((w) => w.length > 1);
  if (words.length > 1 && words.every((w) => n.includes(w))) return 45;
  return 0;
}

function extraNames(el: Element): string[] {
  const out: string[] = [];
  const ph = el.getAttribute('placeholder');
  if (ph) out.push(ph);
  const title = el.getAttribute('title');
  if (title) out.push(title);
  const aria = el.getAttribute('aria-label');
  if (aria) out.push(aria);
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    const name = el.getAttribute('name');
    if (name) out.push(name.replace(/[_-]+/g, ' '));
    const id = el.id;
    if (id) out.push(id.replace(/[_-]+/g, ' '));
    const auto = el.getAttribute('autocomplete');
    if (auto && auto !== 'off' && auto !== 'on') out.push(auto.replace(/-/g, ' '));
    if ((el as HTMLInputElement).type === 'email') out.push('email');
    if ((el as HTMLInputElement).type === 'password') out.push('password');
  }
  if (el.tagName === 'A') {
    const href = el.getAttribute('href');
    if (href) out.push(href);
  }
  return out;
}

function findByText(text: string, action: string, exact = false): { el: Element; role: string; score: number }[] {
  const q = norm(text);
  if (!q) return [];
  const scored: { el: Element; role: string; score: number }[] = [];
  for (const c of candidates()) {
    let s = matchScore(accessibleName(c.el), q);
    if (!exact && s < 100) for (const alt of extraNames(c.el)) s = Math.max(s, matchScore(alt, q) - 8);
    if (exact && s < 100) continue;
    if (s <= 0) continue;
    const r = rectOf(c.el);
    if (r.top >= 0 && r.bottom <= innerHeight) s += 6;
    if ((c.el as HTMLButtonElement).disabled || c.el.getAttribute('aria-disabled') === 'true') s -= 15;
    s += roleBonus(action, c.role);
    // a label that matches → use the control it labels
    if (c.role === 'label') {
      const ctl = (c.el as HTMLLabelElement).control;
      if (ctl) {
        scored.push({ el: ctl, role: roleOf(ctl) ?? 'clickable', score: s + 5 });
        continue;
      }
    }
    scored.push({ el: c.el, role: c.role, score: s });
  }
  if (!scored.length && !exact && action !== 'type' && action !== 'fill') {
    // Not interactive by our heuristics, but the text exists: take the smallest visible element that holds it.
    const el = smallestElementWithText(q);
    if (el) scored.push({ el, role: 'text', score: 20 });
  }
  if ((action === 'type' || action === 'fill') && !scored.some((s) => s.score > 40)) {
    // "type into Email": the text may be a nearby label that is not a <label>
    const near = textFieldNearText(q);
    if (near) scored.push({ el: near, role: 'textbox', score: 50 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function smallestElementWithText(q: string): Element | null {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let best: Element | null = null;
  let bestLen = Infinity;
  let n: Node | null;
  let count = 0;
  while ((n = walker.nextNode()) && count++ < 20000) {
    const t = n.textContent;
    if (!t || t.length > 400) continue;
    if (!norm(t).includes(q)) continue;
    const el = n.parentElement;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const len = t.length;
    if (len < bestLen) {
      best = el;
      bestLen = len;
    }
  }
  return best;
}

function textFieldNearText(q: string): Element | null {
  const el = smallestElementWithText(q);
  if (!el) return null;
  // look inside the same container for the first text field after the text
  let container: Element | null = el;
  for (let i = 0; i < 4 && container; i++) {
    const fields = container.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]), textarea, [contenteditable=true], select');
    for (const f of fields) {
      if (el.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING || container !== el) {
        const r = f.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) return f;
      }
    }
    container = container.parentElement;
  }
  return null;
}

function looksLikeCss(s: string): boolean {
  return /^[#.[]/.test(s) || /^[a-z]+[#.[][^ ]/.test(s) || /\s>\s/.test(s) || /^(input|button|select|textarea|a|form|div|span|li|ul|img)(\[|$|:)/.test(s);
}

function queryCss(sel: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(sel));
  } catch {
    return [];
  }
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

/** Closest names to `text`, for "did you mean" errors. */
function suggestionsFor(text: string, action: string): { ref: number; role: string; name: string }[] {
  const q = norm(text);
  const words = q.split(' ').filter((w) => w.length > 2);
  const out: { ref: number; role: string; name: string; s: number }[] = [];
  for (const c of candidates()) {
    const name = accessibleName(c.el);
    if (!name) continue;
    const n = norm(name);
    let s = 0;
    for (const w of words) if (n.includes(w)) s += 2;
    for (let i = 0; i + 2 < q.length; i += 2) if (n.includes(q.slice(i, i + 3))) s += 0.5;
    s += roleBonus(action, c.role) / 30;
    if (s > 0.9) out.push({ ref: refFor(c.el), role: c.role, name: clean(name, 50), s });
  }
  return out
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map(({ ref, role, name }) => ({ ref, role, name }));
}

export function resolve(p: ResolveParams): Omit<Resolved, 'doc'> | ResolveFailure {
  let el: Element | null = null;
  let role = '';
  let matches = 1;
  let via = '';
  const t = p.target;

  if ('ref' in t) {
    el = elementFor(t.ref);
    via = 'ref';
    if (!el && p.fallbackName) {
      const found = findByText(p.fallbackName, p.action, true).filter((f) => !p.fallbackRole || f.role === p.fallbackRole);
      if (found.length) {
        el = found[0].el;
        role = found[0].role;
        via = 'stale-ref→text';
      }
    }
    if (!el) return { ok: false, error: `ref [${t.ref}] is gone (the page changed). Use visible text instead, or observe again.` };
  } else if ('css' in t) {
    const els = queryCss(t.css);
    const vis = els.filter(visible);
    el = vis[0] ?? els[0] ?? null;
    matches = vis.length || els.length;
    via = 'css';
    if (!el) return { ok: false, error: `No element matches css “${t.css}”.` };
  } else if ('x' in t) {
    el = document.elementFromPoint(t.x, t.y);
    via = 'xy';
    if (!el) return { ok: false, error: `Nothing at (${t.x}, ${t.y}).` };
  } else {
    const text = t.text;
    if (looksLikeCss(text)) {
      const els = queryCss(text).filter(visible);
      if (els.length) {
        el = els[0];
        matches = els.length;
        via = 'css';
      }
    }
    if (!el) {
      const found = findByText(text, p.action, t.exact);
      if (!found.length) return { ok: false, error: `No element matching “${text}”.`, suggestions: suggestionsFor(text, p.action) };
      el = found[0].el;
      role = found[0].role;
      matches = found.filter((f) => f.score >= found[0].score - 2).length;
      via = 'text';
    }
  }

  role ||= roleOf(el) ?? 'clickable';
  // A native checkbox/radio hidden under custom UI: act on its label.
  let pointEl: Element = el;
  if (el.tagName === 'INPUT' && ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || getComputedStyle(el).opacity === '0') pointEl = labelFor(el) ?? el;
  }
  if (el.tagName === 'OPTION') pointEl = el.closest('select') ?? el;

  if (p.scroll !== false) {
    const r = pointEl.getBoundingClientRect();
    const fully = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    if (!fully) (pointEl as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  }

  const rects = Array.from(pointEl.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  const box = rects.length ? rects[0] : pointEl.getBoundingClientRect();
  const points: [number, number][] = [];
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  points.push([cx, cy]);
  // text fields: click near the start so the caret lands inside
  if (isEditable(el) && box.width > 40) points.unshift([box.left + Math.min(20, box.width / 4), cy]);
  points.push([box.left + 3, box.top + 3], [box.right - 3, box.bottom - 3], [box.left + 3, box.bottom - 3], [box.right - 3, box.top + 3]);
  for (const r of rects.slice(1, 3)) points.push([r.left + r.width / 2, r.top + r.height / 2]);

  let x = cx;
  let y = cy;
  let obscuredBy: string | undefined;
  let hit = false;
  for (const [px, py] of points) {
    if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) continue;
    let top = document.elementFromPoint(px, py);
    while (top && top.shadowRoot) {
      const inner = top.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === top) break;
      top = inner;
    }
    if (!top) continue;
    if (top === pointEl || pointEl.contains(top) || top.contains(pointEl) || (top.tagName === 'LABEL' && (top as HTMLLabelElement).control === el)) {
      x = px;
      y = py;
      hit = true;
      break;
    }
    obscuredBy ??= describeEl(top);
  }
  if (hit) obscuredBy = undefined;

  const input = el as HTMLInputElement;
  const isCheckable = el.tagName === 'INPUT' ? input.type === 'checkbox' || input.type === 'radio' : ['checkbox', 'radio', 'switch', 'menuitemcheckbox'].includes(role);
  const checked = el.tagName === 'INPUT' && isCheckable ? input.checked : el.getAttribute('aria-checked') !== null ? el.getAttribute('aria-checked') === 'true' : undefined;
  const br = pointEl.getBoundingClientRect();
  return {
    ok: true,
    ref: refFor(el),
    role,
    name: accessibleName(el),
    tag: el.tagName.toLowerCase(),
    x: Math.round(x),
    y: Math.round(y),
    rect: [Math.round(br.x), Math.round(br.y), Math.round(br.width), Math.round(br.height)],
    editable: isEditable(el),
    inputType: el.tagName === 'INPUT' ? (input.type || 'text').toLowerCase() : undefined,
    isSelect: el.tagName === 'SELECT',
    isFileInput: el.tagName === 'INPUT' && input.type === 'file',
    isCheckable,
    checked,
    disabled: (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
    obscuredBy,
    matches,
    via,
  };
}
