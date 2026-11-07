// Builds the compact page model agents read: interactive elements with refs, headings,
// landmarks and (optionally) short text blocks, in document order.

import type { FrameElement, FrameSnapshot, SnapItem, SnapshotParams } from '../../shared/engine';
import {
  accessibleName,
  clean,
  describeEl,
  inViewport,
  isInteractiveRole,
  isModalDialog,
  landmarkOf,
  mainScroller,
  pruneRefs,
  rectOf,
  refFor,
  roleOf,
  shouldSkip,
} from './dom';

interface Ctx {
  landmark?: string;
  inDialog: boolean;
  inInteractive: boolean;
  parentPointer: boolean;
  hidden: boolean;
}

interface Candidate {
  el: Element;
  role: string;
  ctx: Ctx;
}

const CLICKABLE_HINT_TAGS = new Set(['DIV', 'SPAN', 'LI', 'TD', 'IMG', 'SVG', 'I', 'P', 'LABEL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'ARTICLE', 'SECTION', 'TR', 'DT', 'DD', 'FIGURE', 'PICTURE', 'B', 'STRONG', 'EM', 'SMALL']);

/** Walks the DOM (piercing open shadow roots) and calls visit for every rendered element. */
export function walk(root: Element | ShadowRoot, ctx: Ctx, visit: (el: Element, ctx: Ctx, style: CSSStyleDeclaration) => Ctx | null) {
  const children = root.children;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (shouldSkip(el)) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none') continue;
    if (el.tagName === 'DETAILS' && !(el as HTMLDetailsElement).open) {
      // only the summary of a closed <details> is visible
      const summary = el.querySelector(':scope > summary');
      if (summary) {
        const c = visit(summary, ctx, getComputedStyle(summary));
        if (c) walk(summary, c, visit);
      }
      continue;
    }
    const next = visit(el, ctx, style);
    if (!next) continue;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') continue; // frames report themselves
    if (el.shadowRoot) walk(el.shadowRoot, next, visit);
    walk(el, next, visit);
  }
}

function elementInfo(el: Element, role: string, ctx: Ctx, r: DOMRect, focused: Element | null): FrameElement {
  const tag = el.tagName.toLowerCase();
  const info: FrameElement = {
    ref: refFor(el),
    role,
    name: accessibleName(el),
    tag,
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    inView: inViewport(r),
  };
  if (ctx.landmark) info.landmark = ctx.landmark;
  if (ctx.inDialog) info.inDialog = true;
  if (el === focused) info.focused = true;
  const h = el as HTMLElement;
  if (tag === 'input' || tag === 'textarea') {
    const input = el as HTMLInputElement;
    const type = (input.type || 'text').toLowerCase();
    if (tag === 'input' && type !== 'text') info.inputType = type;
    if (type === 'checkbox' || type === 'radio') info.checked = input.indeterminate ? 'mixed' : input.checked;
    else if (input.value) info.value = type === 'password' ? '•'.repeat(Math.min(8, input.value.length)) : clean(input.value, 80);
    const ph = input.getAttribute('placeholder');
    if (ph && clean(ph) !== info.name) info.placeholder = clean(ph, 60);
    if (input.required) info.required = true;
    if (input.readOnly) info.readonly = true;
    if (input.disabled) info.disabled = true;
  } else if (tag === 'select') {
    const s = el as HTMLSelectElement;
    const sel = Array.from(s.selectedOptions).map((o) => clean(o.label || o.text, 50));
    if (sel.length) info.value = sel.join(', ');
    info.options = Array.from(s.options).slice(0, 12).map((o) => clean(o.label || o.text, 40));
    info.optionCount = s.options.length;
    if (s.disabled) info.disabled = true;
    if (s.required) info.required = true;
  } else if (h.isContentEditable) {
    const t = clean(h.innerText, 80);
    if (t) info.value = t;
  }
  if (tag === 'a') {
    const href = (el as HTMLAnchorElement).href;
    if (href && !href.startsWith('javascript:')) info.href = href;
  }
  const ariaChecked = el.getAttribute('aria-checked');
  if (ariaChecked) info.checked = ariaChecked === 'mixed' ? 'mixed' : ariaChecked === 'true';
  const ariaPressed = el.getAttribute('aria-pressed');
  if (ariaPressed) info.pressed = ariaPressed === 'true';
  const ariaSelected = el.getAttribute('aria-selected');
  if (ariaSelected && (role === 'tab' || role === 'option' || role === 'gridcell' || role === 'treeitem')) info.selected = ariaSelected === 'true';
  const ariaExpanded = el.getAttribute('aria-expanded');
  if (ariaExpanded) info.expanded = ariaExpanded === 'true';
  if (el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled) info.disabled = true;
  if (el.getAttribute('aria-required') === 'true') info.required = true;
  return info;
}

export function snapshot(p: SnapshotParams): Omit<FrameSnapshot, 'doc'> {
  pruneRefs();
  const focused = deepActiveElement();
  const items: SnapItem[] = [];
  const cands: Candidate[] = [];
  let dialog: string | undefined;
  const seenText = new Set<string>();
  let textBudget = p.text ? 6000 : 0;

  const root = document.body || document.documentElement;
  if (!root) return emptySnapshot();

  // First, find an open modal dialog: if there is one, the rest of the page is inert.
  const modal = findModal();
  if (modal) dialog = landmarkOf(modal) || describeEl(modal);

  walk(root, { inDialog: false, inInteractive: false, parentPointer: false, hidden: false }, (el, ctx, style) => {
    let next = ctx;
    const lm = landmarkOf(el);
    if (lm) next = { ...next, landmark: lm };
    if (modal && el === modal) next = { ...next, inDialog: true };
    const hidden = style.visibility === 'hidden' || style.visibility === 'collapse' || el.getAttribute('aria-hidden') === 'true';
    const pointer = style.cursor === 'pointer';
    const tag = el.tagName;

    // headings
    if (/^H[1-6]$/.test(tag) && !hidden) {
      const text = clean((el as HTMLElement).innerText, 120);
      if (text) {
        const r = rectOf(el);
        if (r.width > 0 && r.height > 0) items.push({ k: 'h', level: Number(tag[1]), text, inView: inViewport(r) });
      }
    }

    let role = roleOf(el);
    let interactive = isInteractiveRole(role);
    if (!interactive && !ctx.inInteractive && !hidden) {
      // generic clickables: onclick handlers, tabindex, or a pointer cursor that starts here
      const hasHandler = el.hasAttribute('onclick') || el.hasAttribute('ng-click') || el.hasAttribute('@click') || el.hasAttribute('jsaction');
      const tabbable = el.hasAttribute('tabindex') && (el as HTMLElement).tabIndex >= 0 && tag !== 'DIV' ? true : el.getAttribute('tabindex') === '0';
      if (hasHandler || tabbable || (pointer && !ctx.parentPointer && CLICKABLE_HINT_TAGS.has(tag))) {
        role = el.tagName === 'LABEL' ? 'label' : 'clickable';
        interactive = true;
      }
    }

    if (interactive && !hidden && role) {
      // a native checkbox hidden behind a custom one still counts (we click its label)
      const r = rectOf(el);
      const tiny = r.width < 2 || r.height < 2;
      const opaque = style.opacity !== '0';
      if ((!tiny && opaque) || isHiddenCheckable(el)) {
        if (!modal || next.inDialog || el.contains(modal)) {
          cands.push({ el, role, ctx: next });
          items.push({ k: 'el', el: null as any }); // placeholder, filled below
        }
      }
      next = { ...next, inInteractive: true };
    } else if (p.text && textBudget > 0 && !hidden && !ctx.inInteractive && (!modal || next.inDialog)) {
      // direct text of this element (not of its children)
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      own = clean(own, 220);
      if (own.length > 2 && !seenText.has(own) && !/^H[1-6]$/.test(tag)) {
        seenText.add(own);
        const r = rectOf(el);
        if (r.width > 0 && r.height > 0) {
          items.push({ k: 't', text: own, inView: inViewport(r) });
          textBudget -= own.length;
        }
      }
    }
    if (pointer !== ctx.parentPointer) next = { ...next, parentPointer: pointer };
    return next;
  });

  // Fill element placeholders in order, compute rects once.
  let ci = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.k !== 'el') continue;
    const c = cands[ci++];
    const r = rectOf(isHiddenCheckable(c.el) ? labelFor(c.el) ?? c.el : c.el);
    (it as { k: 'el'; el: FrameElement }).el = elementInfo(c.el, c.role, c.ctx, r, focused);
  }

  let out = items;
  if (p.viewportOnly) out = items.filter((it) => (it.k === 'el' ? it.el.inView : it.inView));
  const total = cands.length;
  out = capItems(out, p.max);

  const se = document.scrollingElement || document.documentElement;
  const scroller = mainScroller();
  const snap: Omit<FrameSnapshot, 'doc'> = {
    url: location.href,
    title: document.title,
    items: out,
    total,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      scrollX: Math.round(scroller ? scroller.scrollLeft : scrollX),
      scrollY: Math.round(scroller ? scroller.scrollTop : scrollY),
      scrollHeight: Math.round(scroller ? scroller.scrollHeight : se.scrollHeight),
      scrollWidth: Math.round(scroller ? scroller.scrollWidth : se.scrollWidth),
    },
    readyState: document.readyState,
  };
  if (scroller) snap.scroller = describeEl(scroller);
  if (dialog) snap.dialog = dialog;
  const f = focused ? out.find((it) => it.k === 'el' && it.el.focused) : undefined;
  if (f && f.k === 'el') snap.focusedRef = f.el.ref;
  return snap;
}

/** Keeps the most useful elements when a page has too many: viewport first, then forms/buttons, then links. */
function capItems(items: SnapItem[], max: number): SnapItem[] {
  const els = items.filter((i) => i.k === 'el') as { k: 'el'; el: FrameElement }[];
  if (els.length <= max) return items;
  const score = (e: FrameElement) => {
    let s = 0;
    if (e.inView) s += 100;
    if (e.inDialog) s += 200;
    if (['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'button', 'switch', 'listbox', 'file'].includes(e.role)) s += 40;
    if (e.landmark === 'main' || e.landmark?.startsWith('form')) s += 20;
    if (e.landmark === 'footer') s -= 30;
    if (e.landmark === 'nav') s -= 5;
    if (!e.name) s -= 20;
    // closer to the viewport is better
    const dy = e.rect[1] < 0 ? -e.rect[1] : Math.max(0, e.rect[1] - innerHeight);
    s -= Math.min(60, dy / 200);
    return s;
  };
  const keep = new Set(
    els
      .map((e) => ({ e, s: score(e.el) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, max)
      .map((x) => x.e),
  );
  return items.filter((i) => i.k !== 'el' || keep.has(i as any));
}

function findModal(): Element | null {
  const dialogs = document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const d = dialogs[i];
    if (!isModalDialog(d)) continue;
    const r = d.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(d).visibility !== 'hidden') return d;
  }
  return null;
}

export function deepActiveElement(): Element | null {
  let a: Element | null = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (a === document.body || a === document.documentElement) return null;
  return a;
}

function isHiddenCheckable(el: Element): boolean {
  if (el.tagName !== 'INPUT') return false;
  const t = (el as HTMLInputElement).type;
  if (t !== 'checkbox' && t !== 'radio') return false;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return (r.width < 2 || r.height < 2 || cs.opacity === '0') && !!labelFor(el);
}

export function labelFor(el: Element): Element | null {
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) return labels[0];
  return el.closest('label');
}

function emptySnapshot(): Omit<FrameSnapshot, 'doc'> {
  return {
    url: location.href,
    title: document.title,
    items: [],
    total: 0,
    viewport: { width: innerWidth, height: innerHeight, scrollX: 0, scrollY: 0, scrollHeight: 0, scrollWidth: 0 },
    readyState: document.readyState,
  };
}

/** All interactive candidates (for text matching), without the formatting work. */
export function candidates(): { el: Element; role: string }[] {
  const out: { el: Element; role: string }[] = [];
  const root = document.body || document.documentElement;
  if (!root) return out;
  const modal = findModal();
  walk(root, { inDialog: false, inInteractive: false, parentPointer: false, hidden: false }, (el, ctx, style) => {
    let next = ctx;
    if (modal && el === modal) next = { ...next, inDialog: true };
    const hidden = style.visibility === 'hidden';
    const pointer = style.cursor === 'pointer';
    let role = roleOf(el);
    let interactive = isInteractiveRole(role);
    if (!interactive && !ctx.inInteractive && !hidden) {
      const hasHandler = el.hasAttribute('onclick') || el.hasAttribute('jsaction');
      if (hasHandler || el.getAttribute('tabindex') === '0' || (pointer && !ctx.parentPointer && CLICKABLE_HINT_TAGS.has(el.tagName))) {
        role = el.tagName === 'LABEL' ? 'label' : 'clickable';
        interactive = true;
      }
    }
    if (interactive && !hidden && role && (!modal || next.inDialog)) {
      const r = rectOf(el);
      if ((r.width >= 2 && r.height >= 2) || isHiddenCheckable(el)) out.push({ el, role });
      next = { ...next, inInteractive: true };
    }
    if (pointer !== ctx.parentPointer) next = { ...next, parentPointer: pointer };
    return next;
  });
  return out;
}
