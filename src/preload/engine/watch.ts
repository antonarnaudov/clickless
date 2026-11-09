// Tracks what changed on the page while an agent acts: new visible text (errors, toasts,
// results), alerts, and how long the DOM has been quiet (for auto-waiting).

import type { WatchResult } from '../../shared/engine';
import { OVERLAY_ID, clean } from './dom';

let lastMutationAt = performance.now();
let mutationsSinceStart = 0;
let added: Node[] = [];
let watching = false;

const observer = new MutationObserver((records) => {
  let relevant = false;
  for (const r of records) {
    const t = r.target as Element;
    if (t.nodeType === 1 && (t.id === OVERLAY_ID || t.id === 'clickless-autofill' || t.closest?.(`#${OVERLAY_ID}, #clickless-autofill`))) continue;
    relevant = true;
    if (watching && r.type === 'childList') for (const n of r.addedNodes) if (added.length < 400) added.push(n);
    if (watching && r.type === 'characterData' && added.length < 400) added.push(r.target);
  }
  if (relevant) {
    lastMutationAt = performance.now();
    mutationsSinceStart++;
  }
});

export function startObserving() {
  const target = document.documentElement;
  if (!target) return;
  observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-expanded', 'open', 'disabled'] });
}

export function quietMs(): number {
  return Math.round(performance.now() - lastMutationAt);
}

/** Visible text lines inside open shadow roots (MutationObserver doesn't see into them). */
function shadowLines(): Set<string> {
  const out = new Set<string>();
  const walk = (root: Document | ShadowRoot, depth: number) => {
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length && i < 6000; i++) {
      const sr = (all[i] as HTMLElement).shadowRoot;
      if (!sr) continue;
      for (const c of Array.from(sr.children)) {
        if (c.tagName === 'STYLE' || c.tagName === 'SCRIPT' || !visible(c)) continue;
        for (const line of ((c as HTMLElement).innerText || '').split('\n')) {
          const t = clean(line, 300);
          if (t.length >= 2) out.add(t);
        }
      }
      if (depth < 4) walk(sr, depth + 1);
    }
  };
  walk(document, 0);
  return out;
}
let shadowBefore = new Set<string>();

export function watchStart(): boolean {
  watching = true;
  added = [];
  mutationsSinceStart = 0;
  shadowBefore = shadowLines();
  return true;
}

function nodeText(n: Node): string {
  if (!n.isConnected) return '';
  if (n.nodeType === 3) {
    const p = n.parentElement;
    if (!p || !visible(p)) return '';
    return n.textContent || '';
  }
  if (n.nodeType !== 1) return '';
  const el = n as HTMLElement;
  if (el.id === OVERLAY_ID || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG'].includes(el.tagName)) return '';
  if (!visible(el)) return '';
  return el.innerText || '';
}

function visible(el: Element): boolean {
  const he = el as HTMLElement;
  if (typeof he.checkVisibility === 'function') return he.checkVisibility({ visibilityProperty: true, opacityProperty: true } as any);
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function watchCollect(): WatchResult {
  watching = false;
  const seen = new Set<string>();
  const out: string[] = [];
  let budget = 1500;
  // Skip nodes contained in other added nodes.
  const nodes = added.filter((n) => !added.some((m) => m !== n && m.contains(n)));
  for (const n of nodes) {
    const t = clean(nodeText(n), 300);
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    budget -= t.length;
    if (budget <= 0) break;
  }
  for (const t of shadowLines()) {
    if (shadowBefore.has(t) || seen.has(t) || budget <= 0) continue;
    seen.add(t);
    out.push(t);
    budget -= t.length;
  }
  const alerts: string[] = [];
  for (const el of Array.from(document.querySelectorAll('[role=alert], [role=status], [aria-live=assertive], [aria-live=polite], .toast, .Toastify__toast, [data-sonner-toast]'))) {
    if (!visible(el)) continue;
    const t = clean((el as HTMLElement).innerText, 200);
    if (t && !alerts.includes(t)) alerts.push(t);
    if (alerts.length >= 5) break;
  }
  added = [];
  return { added: out.slice(0, 12), alerts, mutations: mutationsSinceStart, quietMs: quietMs() };
}

export function hasText(text: string): boolean {
  const body = document.body;
  if (!body) return false;
  return body.innerText.toLowerCase().includes(text.toLowerCase());
}

export function waitFor(p: { text?: string; gone?: string; selector?: string; timeout: number }): Promise<{ ok: boolean; ms: number }> {
  const start = performance.now();
  const check = () => {
    if (p.text && !hasText(p.text)) return false;
    if (p.gone && hasText(p.gone)) return false;
    if (p.selector) {
      try {
        const el = document.querySelector(p.selector);
        if (!el || !visible(el)) return false;
      } catch {
        return true; // invalid selector: don't hang
      }
    }
    return true;
  };
  return new Promise((resolve) => {
    if (check()) return resolve({ ok: true, ms: 0 });
    const iv = setInterval(() => {
      if (check()) {
        clearInterval(iv);
        resolve({ ok: true, ms: Math.round(performance.now() - start) });
      } else if (performance.now() - start > p.timeout) {
        clearInterval(iv);
        resolve({ ok: false, ms: Math.round(performance.now() - start) });
      }
    }, 120);
  });
}
