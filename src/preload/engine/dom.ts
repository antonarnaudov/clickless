// DOM helpers for the content engine: roles, accessible names, visibility, refs.

export const OVERLAY_ID = 'clickless-overlay';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BASE', 'TITLE', 'PARAM', 'SOURCE', 'TRACK']);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'listbox', 'gridcell',
]);

const LANDMARK_TAGS: Record<string, string> = { NAV: 'nav', HEADER: 'header', FOOTER: 'footer', MAIN: 'main', ASIDE: 'aside', FORM: 'form', SEARCH: 'search' };
const LANDMARK_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'main', 'complementary', 'form', 'search', 'dialog', 'alertdialog']);
const ROLE_TO_LANDMARK: Record<string, string> = {
  navigation: 'nav', banner: 'header', contentinfo: 'footer', main: 'main', complementary: 'aside', form: 'form', search: 'search',
  dialog: 'dialog', alertdialog: 'dialog',
};

// ---------- refs ----------

const refOf = new WeakMap<Element, number>();
const elOf = new Map<number, WeakRef<Element>>();
let nextRef = 1;

export function refFor(el: Element): number {
  let r = refOf.get(el);
  if (r === undefined) {
    r = nextRef++;
    refOf.set(el, r);
    elOf.set(r, new WeakRef(el));
  }
  return r;
}

export function elementFor(ref: number): Element | null {
  const el = elOf.get(ref)?.deref();
  if (!el) {
    elOf.delete(ref);
    return null;
  }
  if (!el.isConnected) return null;
  return el;
}

export function pruneRefs() {
  if (elOf.size < 5000) return;
  for (const [r, w] of elOf) if (!w.deref()?.isConnected) elOf.delete(r);
}

// ---------- text ----------

export const clean = (s: string | null | undefined, max = 120): string => {
  if (!s) return '';
  let t = s.replace(/[​-‏⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
};

function textOfIds(ids: string, root: Document | ShadowRoot): string {
  return ids
    .split(/\s+/)
    .map((id) => {
      const n = (root as Document).getElementById?.(id) ?? document.getElementById(id);
      return n ? (n as HTMLElement).innerText || n.textContent || '' : '';
    })
    .join(' ');
}

function visibleText(el: Element): string {
  const h = el as HTMLElement;
  let t = typeof h.innerText === 'string' ? h.innerText : el.textContent || '';
  if (!t.trim()) {
    // icon buttons: <svg><title>, <img alt>, aria-label on a child
    const img = el.querySelector('img[alt]') as HTMLImageElement | null;
    if (img?.alt) return img.alt;
    const svgTitle = el.querySelector('svg title');
    if (svgTitle?.textContent) return svgTitle.textContent;
    const labelled = el.querySelector('[aria-label]');
    if (labelled) return labelled.getAttribute('aria-label') || '';
    const titled = el.querySelector('[title]');
    if (titled) return titled.getAttribute('title') || '';
    const anyImg = el.querySelector('img[src]') as HTMLImageElement | null;
    if (anyImg) {
      const file = (anyImg.getAttribute('src') || '').split(/[?#]/)[0].split('/').pop() || '';
      const base = file.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
      // only human-looking file names ("logo", "github mark"), not hashes or base64
      if (base && base.length < 32 && /^([A-Z]?[a-z]+|[A-Z]+|\d+)( ([A-Z]?[a-z]+|[A-Z]+|\d+))*$/.test(base) && /[aeiouy]/i.test(base)) return `image: ${base}`;
    }
  }
  return t;
}

export function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const t = clean(textOfIds(labelledBy, el.getRootNode() as Document | ShadowRoot));
    if (t) return t;
  }
  if (aria && aria.trim()) return clean(aria);
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const input = el as HTMLInputElement;
    const type = (input.type || '').toLowerCase();
    if (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(type)) return clean(input.value || (type === 'submit' ? 'Submit' : type));
    if (tag === 'INPUT' && type === 'image') return clean(input.alt || input.value || 'Submit');
    const labels = (input as HTMLInputElement).labels;
    if (labels && labels.length) {
      const t = clean(Array.from(labels).map((l) => l.innerText || l.textContent).join(' '));
      if (t) return t;
    }
    const ph = input.getAttribute('placeholder');
    if (ph) return clean(ph);
    const title = input.getAttribute('title');
    if (title) return clean(title);
    // nearby label-ish text: previous sibling text or parent's first text
    const prev = input.previousElementSibling as HTMLElement | null;
    if (prev && prev.innerText && prev.innerText.length < 60) return clean(prev.innerText);
    return clean(input.name || input.id || '');
  }
  if (tag === 'IMG') return clean((el as HTMLImageElement).alt || el.getAttribute('title'));
  const t = clean(visibleText(el), 140);
  if (t) return t;
  return clean(el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || el.getAttribute('data-tooltip') || '');
}

// ---------- roles ----------

export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) {
    const r = explicit.split(/\s+/)[0].toLowerCase();
    if (r !== 'presentation' && r !== 'none' && r !== 'generic') return r;
  }
  const tag = el.tagName;
  switch (tag) {
    case 'A':
      return (el as HTMLAnchorElement).hasAttribute('href') ? 'link' : null;
    case 'BUTTON':
      return 'button';
    case 'SELECT':
      return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    case 'TEXTAREA':
      return 'textbox';
    case 'SUMMARY':
      return 'button';
    case 'INPUT': {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      switch (type) {
        case 'hidden':
          return null;
        case 'checkbox':
          return 'checkbox';
        case 'radio':
          return 'radio';
        case 'range':
          return 'slider';
        case 'number':
          return 'spinbutton';
        case 'search':
          return 'searchbox';
        case 'submit':
        case 'button':
        case 'reset':
        case 'image':
          return 'button';
        case 'file':
          return 'file';
        case 'color':
        case 'date':
        case 'datetime-local':
        case 'month':
        case 'time':
        case 'week':
          return type;
        default:
          return 'textbox';
      }
    }
  }
  if ((el as HTMLElement).isContentEditable && (el.parentElement ? !(el.parentElement as HTMLElement).isContentEditable : true)) return 'textbox';
  return null;
}

export function isInteractiveRole(role: string | null): boolean {
  return !!role && (INTERACTIVE_ROLES.has(role) || role === 'file' || role === 'date' || role === 'time' || role === 'color');
}

export function landmarkOf(el: Element): string | null {
  const role = el.getAttribute('role');
  if (role && LANDMARK_ROLES.has(role)) {
    const name = el.getAttribute('aria-label');
    const base = ROLE_TO_LANDMARK[role];
    return name ? `${base} “${clean(name, 40)}”` : base;
  }
  if (el.tagName === 'DIALOG') {
    const name = el.getAttribute('aria-label') || el.querySelector('h1,h2,h3')?.textContent;
    return name ? `dialog “${clean(name, 40)}”` : 'dialog';
  }
  const lm = LANDMARK_TAGS[el.tagName];
  if (!lm) return null;
  // header/footer only count when not nested inside article/section
  if ((lm === 'header' || lm === 'footer') && el.closest('article,section,aside,main') !== null) return null;
  if (lm === 'form') {
    const name = el.getAttribute('aria-label') || el.getAttribute('name');
    return name ? `form “${clean(name, 40)}”` : 'form';
  }
  return lm;
}

export function isModalDialog(el: Element): boolean {
  if (el.tagName === 'DIALOG') return (el as HTMLDialogElement).open && el.matches(':modal');
  const role = el.getAttribute('role');
  return (role === 'dialog' || role === 'alertdialog') && el.getAttribute('aria-modal') === 'true';
}

export function shouldSkip(el: Element): boolean {
  return SKIP_TAGS.has(el.tagName) || el.id === OVERLAY_ID;
}

// ---------- geometry ----------

export function rectOf(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) return r;
  // display: contents or inline wrappers: union of children
  const rects = el.getClientRects();
  if (rects.length) return rects[0];
  return r;
}

export function inViewport(r: DOMRect, margin = 0): boolean {
  return r.bottom > -margin && r.right > -margin && r.top < innerHeight + margin && r.left < innerWidth + margin && r.width > 0 && r.height > 0;
}

export function describeEl(el: Element): string {
  const h = el as HTMLElement;
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  else if (typeof h.className === 'string' && h.className.trim()) s += '.' + h.className.trim().split(/\s+/).slice(0, 2).join('.');
  const name = accessibleName(el);
  if (name) s += ` “${clean(name, 50)}”`;
  return s;
}

/** The element that scrolls the page: the window, or the biggest scrollable container. */
export function mainScroller(): Element | null {
  const se = document.scrollingElement || document.documentElement;
  if (se.scrollHeight > innerHeight + 4 && getComputedStyle(document.body).overflowY !== 'hidden') return null; // window scrolls
  let best: Element | null = null;
  let bestArea = 0;
  const cx = innerWidth / 2;
  const cy = innerHeight / 2;
  let n = document.elementFromPoint(cx, cy);
  while (n && n !== document.documentElement) {
    const cs = getComputedStyle(n);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 4) {
      const area = n.clientWidth * n.clientHeight;
      if (area > bestArea) {
        best = n;
        bestArea = area;
      }
    }
    n = n.parentElement;
  }
  return best;
}

export function isEditable(el: Element): boolean {
  if (el.tagName === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly && !(el as HTMLTextAreaElement).disabled;
  if (el.tagName === 'INPUT') {
    const i = el as HTMLInputElement;
    const t = (i.type || 'text').toLowerCase();
    return !i.readOnly && !i.disabled && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color', 'hidden'].includes(t);
  }
  return (el as HTMLElement).isContentEditable;
}
