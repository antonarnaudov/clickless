import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CircleAlert, CornerDownLeft, GripVertical, RotateCw, Search, Sparkles, SquareArrowOutUpRight, X } from 'lucide-react';
import type { Command } from '../../shared/ipc';
import type { Rect, Tab, UIState } from '../../shared/types';
import { cmd, useShellEvents } from '../common/api';
import { Favicon } from '../common/Favicon';
import { cx, hostOf } from '../common/util';
import { splitDrag, useSplitDrag, type DropZone } from './dnd';

const MAX_PANES = 4;
const EDGE = 0.28;

/**
 * Where the native page views go. The shell only draws the cards (shadow, rounded frame, agent
 * glow, split pane headers) and reports the card rects; main lays the WebContentsViews exactly on
 * top. While a tab or a pane is dragged over the pages, main lifts the views off and the shell
 * shows snapshots with drop zones instead.
 */
export const Viewport = memo(function Viewport({ state }: { state: UIState }) {
  const split = state.split;
  const ids: (string | null)[] = split ? split.tabIds : [state.activeTabId];
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const paneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastSent = useRef('');
  const raf = useRef(0);
  const [sizes, setSizes] = useState<number[]>(split?.sizes ?? [1]);
  const [resizing, setResizing] = useState<number | null>(null);
  const [shots, setShots] = useState<Record<string, string> | null>(null);
  const drag = useSplitDrag();
  const lifted = useRef(false);

  useEffect(() => {
    if (resizing === null) setSizes(split?.sizes ?? [1]);
  }, [split?.sizes?.join(','), split?.tabIds.length, resizing]);

  useShellEvents((e) => {
    if (e.type === 'lift') setShots(e.shots);
  });

  const report = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const rects: Rect[] = [];
      for (let i = 0; i < ids.length; i++) {
        const el = cardRefs.current[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        rects.push({ x: Math.round(r.left), y: Math.round(r.top), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) });
      }
      const key = JSON.stringify(rects);
      if (key === lastSent.current) return;
      lastSent.current = key;
      cmd({ type: 'ui.viewports', rects });
    });
  }, [ids.join(',')]);

  // Size changes of the cards (sidebar/panel resize, banners, find bar, window resize).
  useLayoutEffect(() => {
    const ro = new ResizeObserver(report);
    cardRefs.current.forEach((el) => el && ro.observe(el));
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener('resize', report);
    report();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
      cancelAnimationFrame(raf.current);
    };
  }, [report, ids.length]);

  // Position-only changes (e.g. a banner above appears while the height stays): check every render.
  useLayoutEffect(() => {
    report();
  });

  // Main may restart; re-send on focus.
  useEffect(() => {
    const f = () => {
      lastSent.current = '';
      report();
    };
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, [report]);

  // ----- drop zones for a tab or pane being dragged -----
  useEffect(() => {
    if (!drag) {
      if (lifted.current) {
        lifted.current = false;
        cmd({ type: 'ui.dragLift', on: false });
      }
      return;
    }
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    const inside = drag.x >= box.left && drag.x <= box.right && drag.y >= box.top && drag.y <= box.bottom;
    if (inside && !lifted.current) {
      lifted.current = true;
      cmd({ type: 'ui.dragLift', on: true });
    }
    splitDrag.setZone(zoneFor(drag.item, drag.x, drag.y, box, ids, paneRefs.current, state));
  }, [drag?.x, drag?.y, drag?.item.tabId, drag?.item.kind]);

  // ----- resizing between panes -----
  const startResize = (k: number) => (e: React.PointerEvent) => {
    if (!split || !wrapRef.current) return;
    e.preventDefault();
    const box = wrapRef.current.getBoundingClientRect();
    const start = [...sizes];
    const startX = e.clientX;
    let next = start;
    setResizing(k);
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - startX) / box.width;
      const a = Math.max(0.12, Math.min(start[k - 1] + start[k] - 0.12, start[k - 1] + d));
      next = [...start];
      next[k - 1] = a;
      next[k] = start[k - 1] + start[k] - a;
      setSizes(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResizing(null);
      cmd({ type: 'ui.split', tabIds: null, sizes: next });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ----- dragging a pane by its grip -----
  const startPaneDrag = (tabId: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!started) {
        started = true;
        splitDrag.start({ kind: 'pane', tabId }, ev.clientX, ev.clientY);
      }
      splitDrag.move(ev.clientX, ev.clientY);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!started) return;
      const action = splitDrag.end();
      if (action) cmd(action);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const agent = state.agent;
  const agentOn = (id: string | null) => agent.active && !agent.paused && (split ? agent.tabId === id : true);
  const box = wrapRef.current?.getBoundingClientRect();
  const zone = drag?.zone;

  return (
    <div className={cx('viewport', split && 'split', drag && 'dragging')} ref={wrapRef}>
      {ids.map((id, i) => {
        const tab = id ? state.tabs.find((t) => t.id === id) : undefined;
        const focused = !!split && id === state.activeTabId;
        return (
          <FragmentWithHandle key={id ?? i} showHandle={i > 0} resizing={resizing === i} onPointerDown={startResize(i)} onDoubleClick={() => cmd({ type: 'ui.split', tabIds: null, sizes: ids.map(() => 1 / ids.length) })}>
            <div
              className={cx('pane', focused && 'focused', drag?.item.kind === 'pane' && drag.item.tabId === id && 'lifting')}
              ref={(el) => {
                paneRefs.current[i] = el;
              }}
              style={split ? { flex: `${sizes[i] ?? 1 / ids.length} 1 0` } : undefined}
            >
              {split && tab && <PaneHeader tab={tab} focused={focused} onGrip={startPaneDrag(tab.id)} />}
              <div
                ref={(el) => {
                  cardRefs.current[i] = el;
                }}
                className={cx('card', agentOn(id) && 'relay', agent.paused && 'paused-ring')}
              >
                {shots && id && shots[id] ? <img className="card-shot" src={shots[id]} alt="" draggable={false} /> : <CardFallback tab={tab} spaceName={state.spaces.find((s) => s.id === state.activeSpaceId)?.name} />}
              </div>
            </div>
          </FragmentWithHandle>
        );
      })}
      {zone && box && (
        <div className="drop-zone" style={{ left: zone.rect.x - box.left, top: zone.rect.y - box.top, width: zone.rect.width, height: zone.rect.height }}>
          <span>{zone.label}</span>
        </div>
      )}
    </div>
  );
});

/** Which drop zone is under the pointer, and what dropping there does. */
function zoneFor(item: { kind: 'tab' | 'pane'; tabId: string }, x: number, y: number, box: DOMRect, ids: (string | null)[], panes: (HTMLDivElement | null)[], state: UIState): DropZone | null {
  const split = state.split;
  const rectOf = (r: DOMRect, from: number, to: number) => ({ x: r.left + r.width * from, y: r.top, width: r.width * (to - from), height: r.height });
  // A pane dragged out of the page area, onto the sidebar: take it out of the split.
  if (item.kind === 'pane' && x < box.left) {
    return { action: { type: 'split.remove', tabId: item.tabId }, rect: { x: box.left, y: box.top, width: 0, height: 0 }, label: '' };
  }
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
  if (!split) {
    const only = ids[0];
    if (!only || only === item.tabId) return null;
    const left = x < box.left + box.width / 2;
    return { action: { type: 'split.insert', tabId: item.tabId, index: left ? 0 : 1 }, rect: rectOf(box, left ? 0 : 0.5, left ? 0.5 : 1), label: left ? 'Split left' : 'Split right' };
  }
  for (let i = 0; i < ids.length; i++) {
    const el = panes[i];
    const id = ids[i];
    if (!el || !id) continue;
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right) continue;
    const fx = (x - r.left) / r.width;
    const inSplit = split.tabIds.includes(item.tabId);
    if (item.kind === 'pane' && id === item.tabId) return null;
    const full = !inSplit && split.tabIds.length >= MAX_PANES;
    const reduced = split.tabIds.filter((t) => t !== item.tabId);
    const pos = reduced.indexOf(id);
    if (!full && fx < EDGE) return { action: { type: 'split.insert', tabId: item.tabId, index: pos }, rect: rectOf(r, 0, 0.5), label: item.kind === 'pane' ? 'Move here' : 'Add to the left' };
    if (!full && fx > 1 - EDGE) return { action: { type: 'split.insert', tabId: item.tabId, index: pos + 1 }, rect: rectOf(r, 0.5, 1), label: item.kind === 'pane' ? 'Move here' : 'Add to the right' };
    return { action: { type: 'split.replace', tabId: item.tabId, index: i }, rect: rectOf(r, 0, 1), label: inSplit ? 'Swap' : 'Replace' };
  }
  return null;
}

function PaneHeader({ tab, focused, onGrip }: { tab: Tab; focused: boolean; onGrip(e: React.PointerEvent): void }) {
  return (
    <div className={cx('pane-head', focused && 'on')} onMouseDown={() => !focused && cmd({ type: 'tab.activate', tabId: tab.id })}>
      <button className="grip" title="Drag to move this pane · drop it on the sidebar to take it out" onPointerDown={onGrip}>
        <GripVertical size={13} />
      </button>
      <Favicon src={tab.favicon} url={tab.url} title={tab.title} size={14} />
      <span className="title truncate">{tab.title || hostOf(tab.url)}</span>
      <button className="icon-btn sm" title="Take out of split (keeps the tab)" onClick={(e) => (e.stopPropagation(), cmd({ type: 'split.remove', tabId: tab.id }))}>
        <SquareArrowOutUpRight size={13} />
      </button>
      <button className="icon-btn sm" title="Close tab" onClick={(e) => (e.stopPropagation(), cmd({ type: 'tab.close', tabId: tab.id }))}>
        <X size={13} />
      </button>
    </div>
  );
}

function FragmentWithHandle({ showHandle, resizing, onPointerDown, onDoubleClick, children }: { showHandle: boolean; resizing: boolean; onPointerDown(e: React.PointerEvent): void; onDoubleClick(): void; children: React.ReactNode }) {
  return (
    <>
      {showHandle && <div className={cx('split-handle', resizing && 'on')} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} title="Drag to resize · double-click for equal widths" />}
      {children}
    </>
  );
}

/** Visible only where no page view is shown: empty space, failed load. */
function CardFallback({ tab, spaceName }: { tab?: Tab; spaceName?: string }) {
  if (tab?.error) {
    return (
      <div className="card-fallback">
        <div className="empty-card">
          <div className="err-mark">
            <CircleAlert size={22} />
          </div>
          <h2 style={{ fontSize: 22 }}>Can’t reach {hostOf(tab.url) || 'this page'}</h2>
          <p>{tab.error}</p>
          <button className="btn btn-primary" onClick={() => cmd({ type: 'tab.reload', tabId: tab.id })}>
            <RotateCw size={13} /> Try again
          </button>
        </div>
      </div>
    );
  }
  if (tab) return <div className="card-fallback" />;
  return (
    <div className="card-fallback">
      <div className="empty-card">
        <h2>{spaceName ? `${spaceName} is clear` : 'Nothing open'}</h2>
        <p>Open a site, search the web, or ask the agent to do something for you.</p>
        <button className="prompt" onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'palette', mode: 'new-tab' } })}>
          <Search size={15} />
          <span>Search or enter address</span>
          <span className="kbd">⌘T</span>
        </button>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-soft btn-sm" onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'palette', mode: 'ask' } })}>
            <Sparkles size={12} /> Ask AI
          </button>
          <button className="btn btn-soft btn-sm" onClick={() => cmd({ type: 'ui.panel', open: true })}>
            <CornerDownLeft size={12} /> Give the agent a task
          </button>
        </div>
      </div>
    </div>
  );
}

