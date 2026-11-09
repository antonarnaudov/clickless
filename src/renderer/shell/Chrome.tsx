import { memo, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, CircleAlert, CircleCheck, Hand, Info, Lock, PanelLeft, Pause, Play, RotateCw, ShieldCheck, Sparkles, Square, X } from 'lucide-react';
import type { Banner, FindState, Tab, UIState } from '../../shared/types';
import { cmd } from '../common/api';
import { cx, displayUrl, isSecure } from '../common/util';

/** Compact bar above the page: shown when the sidebar is hidden or "URL above the page" is on. */
export const TopBar = memo(function TopBar({ state, tab }: { state: UIState; tab: Tab | null }) {
  const lights = state.platform === 'darwin' && !state.fullscreen && !state.sidebar.visible;
  const a = state.agent;
  const url = tab ? displayUrl(tab.url) : '';
  return (
    <div className={cx('topbar drag', lights && 'lights')}>
      {!state.sidebar.visible && (
        <button className="icon-btn" title="Show sidebar (⌘S)" onClick={() => cmd({ type: 'ui.sidebar', visible: true })}>
          <PanelLeft size={16} strokeWidth={1.8} />
        </button>
      )}
      <button className="icon-btn" disabled={!tab?.canGoBack} onClick={() => cmd({ type: 'tab.back' })} title="Back">
        <ArrowLeft size={16} strokeWidth={1.9} />
      </button>
      <button className="icon-btn" disabled={!tab?.canGoForward} onClick={() => cmd({ type: 'tab.forward' })} title="Forward">
        <ArrowRight size={16} strokeWidth={1.9} />
      </button>
      <button className="icon-btn" disabled={!tab} onClick={() => cmd({ type: tab?.loading ? 'tab.stop' : 'tab.reload' })} title="Reload">
        {tab?.loading ? <X size={16} /> : <RotateCw size={15} strokeWidth={1.9} />}
      </button>
      <button
        className="url-pill"
        onClick={() => cmd({ type: 'ui.overlay', overlay: { kind: 'palette', mode: 'navigate', initial: tab?.url.startsWith('clickless://newtab') ? '' : tab?.url, tabId: tab?.id } })}
        title={tab?.url}
      >
        {tab && isSecure(tab.url) && <Lock size={11} strokeWidth={2.3} style={{ flex: 'none', color: 'var(--ink-3)' }} />}
        <span className="t truncate">{url || 'Search or enter address'}</span>
      </button>
      {(a.active || a.paused) && (
        <div className="agent-pill">
          <span className={cx(a.paused && 'paused')} style={{ display: 'contents' }}>
            <span className="pulse-dot" />
          </span>
          <span className="truncate">
            <b>{a.paused ? 'Agents paused' : (a.source ?? 'Agent')}</b>
            {!a.paused && a.label ? ` · ${a.label}` : ''}
          </span>
          {a.paused ? (
            <button className="icon-btn sm" title="Resume agents" onClick={() => cmd({ type: 'agent.pause', paused: false })}>
              <Play size={12} fill="currentColor" />
            </button>
          ) : (
            <>
              <button className="icon-btn sm" title="Pause agents" onClick={() => cmd({ type: 'agent.pause', paused: true })}>
                <Pause size={12} fill="currentColor" />
              </button>
              <button className="icon-btn sm" title="Stop" style={{ color: 'var(--danger)' }} onClick={() => cmd({ type: 'agent.stop' })}>
                <Square size={11} fill="currentColor" />
              </button>
            </>
          )}
        </div>
      )}
      {/* with the sidebar showing, its “Ask Clickless” row is the one way in */}
      {!state.sidebar.visible && (
        <button className="icon-btn" title="Ask Clickless (⌘E)" style={state.panel.open ? { color: 'var(--accent-text)' } : undefined} onClick={() => cmd({ type: 'ui.panel', open: !state.panel.open })}>
          <Sparkles size={15} strokeWidth={1.9} />
        </button>
      )}
    </div>
  );
});

export const Banners = memo(function Banners({ banners }: { banners: Banner[] }) {
  if (!banners.length) return null;
  return (
    <div className="banners">
      {banners.map((b) => (
        <div key={b.id} className={cx('banner', b.kind)} role="alert">
          <span className="bi">
            {b.kind === 'handoff' ? <Hand size={14} /> : b.kind === 'permission' ? <ShieldCheck size={14} /> : b.kind === 'error' ? <CircleAlert size={14} /> : <Info size={14} />}
          </span>
          <span className="bt">
            <b className="truncate">{b.title}</b>
            {b.detail && <span>{b.detail}</span>}
          </span>
          <span className="ba">
            {b.actions.map((act, i) => (
              <button key={act.value} className={cx('btn btn-sm', i === 0 ? 'btn-primary' : 'btn-ghost')} onClick={() => cmd({ type: 'banner.respond', bannerId: b.id, value: act.value })}>
                {act.label}
              </button>
            ))}
            {!b.actions.length && (
              <button className="icon-btn sm" onClick={() => cmd({ type: 'banner.respond', bannerId: b.id, value: 'dismiss' })}>
                <X size={13} />
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
});

export function FindBar({ find, focusSignal, onClose }: { find: FindState | null; focusSignal: number; onClose(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(find?.query ?? '');
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [focusSignal]);
  const close = () => {
    cmd({ type: 'ui.find', close: true });
    onClose();
  };
  return (
    <div className="findbar">
      <input
        ref={ref}
        value={q}
        placeholder="Find in page"
        onChange={(e) => {
          setQ(e.target.value);
          cmd({ type: 'ui.find', query: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') cmd({ type: 'ui.find', query: q, next: !e.shiftKey, back: e.shiftKey });
          if (e.key === 'Escape') close();
        }}
      />
      {find && find.query && <span className="count">{find.matches ? `${find.activeMatch} of ${find.matches}` : 'No matches'}</span>}
      <button className="icon-btn sm" title="Previous (⇧↩)" onClick={() => cmd({ type: 'ui.find', query: q, back: true })}>
        <ChevronUp size={14} />
      </button>
      <button className="icon-btn sm" title="Next (↩)" onClick={() => cmd({ type: 'ui.find', query: q, next: true })}>
        <ChevronDown size={14} />
      </button>
      <button className="icon-btn sm" title="Close (Esc)" onClick={close}>
        <X size={14} />
      </button>
    </div>
  );
}

export interface ToastT {
  id: number;
  text: string;
  tone?: 'info' | 'success' | 'error';
}

export function Toasts({ toasts }: { toasts: ToastT[] }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.tone)}>
          {t.tone === 'success' ? <CircleCheck size={14} /> : t.tone === 'error' ? <CircleAlert size={14} /> : <Info size={14} style={{ opacity: 0.7 }} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
