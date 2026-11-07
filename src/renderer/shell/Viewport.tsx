import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CircleAlert, CornerDownLeft, RotateCw, Search, Sparkles } from 'lucide-react';
import type { Rect, Tab, UIState } from '../../shared/types';
import { cmd } from '../common/api';
import { cx, hostOf } from '../common/util';

/**
 * Where the native page views go. The shell only draws the card (shadow, rounded frame, agent
 * glow) and reports the card rects; main lays the WebContentsViews exactly on top.
 */
export const Viewport = memo(function Viewport({ state }: { state: UIState }) {
  const split = state.split;
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastSent = useRef('');
  const raf = useRef(0);
  const [ratio, setRatio] = useState(split?.ratio ?? 0.5);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) setRatio(split?.ratio ?? 0.5);
  }, [split?.ratio, dragging]);

  const report = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const n = split ? 2 : 1;
      const rects: Rect[] = [];
      for (let i = 0; i < n; i++) {
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
  }, [split]);

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
  }, [report, !!split]);

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

  const startDrag = (e: React.PointerEvent) => {
    if (!split || !wrapRef.current) return;
    e.preventDefault();
    const box = wrapRef.current.getBoundingClientRect();
    setDragging(true);
    let r = ratio;
    const move = (ev: PointerEvent) => {
      r = Math.min(0.8, Math.max(0.2, (ev.clientX - box.left) / box.width));
      setRatio(r);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
      cmd({ type: 'ui.split', tabIds: split.tabIds, ratio: r });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const ids = split ? split.tabIds : [state.activeTabId];
  const agent = state.agent;
  const agentOn = (id: string | null) => agent.active && !agent.paused && (split ? agent.tabId === id : true);

  return (
    <div className="viewport" ref={wrapRef}>
      {ids.map((id, i) => {
        const tab = id ? state.tabs.find((t) => t.id === id) : undefined;
        return (
          <FragmentWithHandle key={i} showHandle={i === 1} dragging={dragging} onPointerDown={startDrag}>
            <div
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              className={cx('card', agentOn(id) && 'relay', agent.paused && 'paused-ring')}
              style={split ? { flex: `${i === 0 ? ratio : 1 - ratio} 1 0` } : undefined}
            >
              <CardFallback tab={tab} spaceName={state.spaces.find((s) => s.id === state.activeSpaceId)?.name} />
            </div>
          </FragmentWithHandle>
        );
      })}
    </div>
  );
});

function FragmentWithHandle({ showHandle, dragging, onPointerDown, children }: { showHandle: boolean; dragging: boolean; onPointerDown(e: React.PointerEvent): void; children: React.ReactNode }) {
  return (
    <>
      {showHandle && <div className={cx('split-handle', dragging && 'on')} onPointerDown={onPointerDown} onDoubleClick={() => cmd({ type: 'ui.split', tabIds: null })} title="Drag to resize · double-click to close split" />}
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

