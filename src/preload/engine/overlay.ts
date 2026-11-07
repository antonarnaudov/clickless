// The agent's visible hands: an animated cursor, a highlight ring with a label, click ripples,
// and numbered set-of-marks boxes for screenshots. Lives in a closed shadow root, ignores input.

import { OVERLAY_ID } from './dom';

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let cursor: HTMLElement | null = null;
let ring: HTMLElement | null = null;
let tag: HTMLElement | null = null;
let marksLayer: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let last = { x: -1, y: -1 };

const CSS = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; overflow: hidden; }
.cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; transform: translate(-100px,-100px);
  transition-property: transform, opacity; transition-timing-function: cubic-bezier(.22,.8,.26,1); opacity: 0;
  filter: drop-shadow(0 2px 5px rgba(0,0,0,.35)) drop-shadow(0 0 7px rgba(60,240,180,.55)); will-change: transform; }
.cursor svg { width: 26px; height: 26px; display: block; }
.cursor.on { opacity: 1; }
.ring { position: absolute; border-radius: 8px; border: 2px solid #3cf0b4; box-shadow: 0 0 0 4px rgba(60,240,180,.18), 0 0 26px rgba(60,240,180,.45);
  opacity: 0; transition: all .18s ease-out; }
.ring.on { opacity: 1; }
.tag { position: absolute; padding: 3px 8px; border-radius: 999px; font: 600 11px/16px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
  color: #f4f7f2; background: #06201c; border: 1px solid rgba(60,240,180,.45); white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis;
  opacity: 0; transform: translateY(4px); transition: opacity .15s ease-out, transform .15s ease-out; box-shadow: 0 4px 14px rgba(6,32,28,.35), 0 0 14px rgba(60,240,180,.25); }
.tag.on { opacity: 1; transform: translateY(0); }
.ripple { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; border: 2.5px solid #3cf0b4;
  opacity: 0; animation: ripple .75s cubic-bezier(.2,.7,.3,1) forwards; }
/* three rings radiating from the click point: the same image as the Clickless logo */
@keyframes ripple { 0% { transform: scale(.35); opacity: .95; } 100% { transform: scale(3.6); opacity: 0; } }
.mark { position: absolute; border: 1.5px solid rgba(16,165,146,.9); border-radius: 4px; background: rgba(16,165,146,.06); }
.mark b { position: absolute; left: -1px; top: -15px; min-width: 14px; padding: 0 3px; height: 14px; border-radius: 3px; background: #06201c; color: #3cf0b4;
  font: 700 10px/14px ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; }
.mark.low b { top: auto; bottom: -15px; }
`;

const CURSOR_SVG = `<svg viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#14473d"/><stop offset="1" stop-color="#06201c"/></linearGradient></defs>
<path d="M4 2.5 L21 12.2 L13.4 13.9 L10 21.5 Z" fill="url(#g)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

function ensure(): ShadowRoot | null {
  if (window.top !== window) return null;
  if (host && host.isConnected && root) return root;
  if (!document.documentElement) return null;
  host = document.createElement('div');
  host.id = OVERLAY_ID;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;';
  root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const layer = document.createElement('div');
  layer.className = 'layer';
  marksLayer = document.createElement('div');
  ring = document.createElement('div');
  ring.className = 'ring';
  tag = document.createElement('div');
  tag.className = 'tag';
  cursor = document.createElement('div');
  cursor.className = 'cursor';
  cursor.innerHTML = CURSOR_SVG;
  layer.append(marksLayer, ring, tag, cursor);
  root.append(style, layer);
  document.documentElement.appendChild(host);
  return root;
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    cursor?.classList.remove('on');
    ring?.classList.remove('on');
    tag?.classList.remove('on');
  }, 1800);
}

export function pointer(p: { x: number; y: number; label?: string; rect?: [number, number, number, number]; ms: number; click?: boolean }): Promise<boolean> {
  const r = ensure();
  if (!r || !cursor || !ring || !tag) return Promise.resolve(false);
  if (hideTimer) clearTimeout(hideTimer);
  const fromHidden = !cursor.classList.contains('on') || last.x < 0;
  const ms = fromHidden ? 0 : Math.max(0, p.ms);
  if (fromHidden) {
    // appear near the target, then glide in
    const sx = Math.max(0, p.x - 60);
    const sy = Math.max(0, p.y + 50);
    cursor.style.transitionDuration = '0ms';
    cursor.style.transform = `translate(${sx}px, ${sy}px)`;
    void cursor.offsetWidth;
  }
  const travel = fromHidden ? Math.max(120, p.ms * 0.7) : ms;
  cursor.style.transitionDuration = `${travel}ms`;
  cursor.classList.add('on');
  cursor.style.transform = `translate(${p.x - 4}px, ${p.y - 2}px)`;
  last = { x: p.x, y: p.y };
  if (p.rect) {
    const [x, y, w, h] = p.rect;
    Object.assign(ring.style, { left: `${x - 4}px`, top: `${y - 4}px`, width: `${w + 8}px`, height: `${h + 8}px` });
    ring.classList.add('on');
  } else ring.classList.remove('on');
  if (p.label) {
    tag.textContent = p.label;
    const below = (p.rect ? p.rect[1] + p.rect[3] : p.y) + 10;
    const top = below + 24 > innerHeight ? (p.rect ? p.rect[1] : p.y) - 30 : below;
    Object.assign(tag.style, { left: `${Math.min(Math.max(8, p.x - 20), innerWidth - 330)}px`, top: `${Math.max(4, top)}px` });
    tag.classList.add('on');
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      if (p.click && root) {
        const layer = root.querySelector('.layer');
        [0, 110, 220].forEach((delay) => {
          const rip = document.createElement('div');
          rip.className = 'ripple';
          rip.style.left = `${p.x}px`;
          rip.style.top = `${p.y}px`;
          rip.style.animationDelay = `${delay}ms`;
          layer?.appendChild(rip);
          setTimeout(() => rip.remove(), 900 + delay);
        });
      }
      scheduleHide();
      resolve(true);
    }, travel);
  });
}

export function pointerHide(): boolean {
  cursor?.classList.remove('on');
  ring?.classList.remove('on');
  tag?.classList.remove('on');
  last = { x: -1, y: -1 };
  return true;
}

export function marks(boxes: { n: number; rect: [number, number, number, number] }[]): boolean {
  if (!ensure() || !marksLayer) return false;
  marksLayer.replaceChildren();
  for (const b of boxes) {
    const [x, y, w, h] = b.rect;
    if (w < 1 || h < 1 || y + h < 0 || y > innerHeight || x + w < 0 || x > innerWidth) continue;
    const m = document.createElement('div');
    m.className = y < 16 ? 'mark low' : 'mark';
    Object.assign(m.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    const label = document.createElement('b');
    label.textContent = String(b.n);
    m.appendChild(label);
    marksLayer.appendChild(m);
  }
  return true;
}

export function clearMarks(): boolean {
  marksLayer?.replaceChildren();
  return true;
}
