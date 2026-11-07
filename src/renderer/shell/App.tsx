import { useCallback, useEffect, useRef, useState } from 'react';
import { cmd, useShellEvents, useUIState } from '../common/api';
import { useTheme } from '../common/theme';
import { cx } from '../common/util';
import { AgentPanel } from './AgentPanel';
import { Banners, FindBar, Toasts, TopBar, type ToastT } from './Chrome';
import { ContextMenuHost } from './ContextMenu';
import { Sidebar } from './Sidebar';
import { Viewport } from './Viewport';

const SIDEBAR_MIN = 216;
const SIDEBAR_MAX = 420;
const PANEL_MIN = 300;
const PANEL_MAX = 680;

export function App() {
  const state = useUIState();
  useTheme(state);
  const [toasts, setToasts] = useState<ToastT[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const [panelFocus, setPanelFocus] = useState(0);
  const [sbWidth, setSbWidth] = useState<number | null>(null);
  const [pnWidth, setPnWidth] = useState<number | null>(null);
  const toastId = useRef(0);

  const toast = useCallback((text: string, tone?: ToastT['tone']) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
  }, []);

  useShellEvents((e) => {
    switch (e.type) {
      case 'find-open':
        setFindOpen(true);
        setFindFocus((n) => n + 1);
        break;
      case 'focus-sidebar-url': {
        const tab = state?.tabs.find((t) => t.id === state.activeTabId);
        cmd({ type: 'ui.overlay', overlay: { kind: 'palette', mode: 'navigate', initial: tab?.url.startsWith('clickless://newtab') ? '' : tab?.url, tabId: tab?.id } });
        break;
      }
      case 'panel-focus':
        if (state && !state.panel.open) cmd({ type: 'ui.panel', open: true });
        setPanelFocus((n) => n + 1);
        break;
      case 'toast':
        toast(e.text, e.tone);
        break;
    }
  });

  // Main ended the find session (e.g. the page navigated): close the bar too.
  const prevFind = useRef(state?.find ?? null);
  useEffect(() => {
    const now = state?.find ?? null;
    if (prevFind.current && !now) setFindOpen(false);
    prevFind.current = now;
  }, [state?.find]);

  // Drop the local width override once main has applied it.
  useEffect(() => {
    if (sbWidth !== null && state && Math.abs(state.sidebar.width - sbWidth) < 1) setSbWidth(null);
  }, [state?.sidebar.width, sbWidth]);
  useEffect(() => {
    if (pnWidth !== null && state && Math.abs(state.panel.width - pnWidth) < 1) setPnWidth(null);
  }, [state?.panel.width, pnWidth]);

  if (!state) return <div className="shell grain" />;

  const sidebarW = state.sidebar.visible ? (sbWidth ?? state.sidebar.width) : 0;
  const panelW = state.panel.open ? (pnWidth ?? state.panel.width) : 0;
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  const showTop = !state.sidebar.visible || state.settings.appearance.compactUrl;

  const resize = (which: 'sidebar' | 'panel') => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = which === 'sidebar' ? sidebarW : panelW;
    let w = start;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (which === 'sidebar') {
        w = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, start + dx)));
        setSbWidth(w);
      } else {
        w = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, start - dx)));
        setPnWidth(w);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      // Keep the local width until main echoes it back (see effects above); give up after 1.5 s.
      if (which === 'sidebar') {
        cmd({ type: 'ui.sidebar', width: w });
        setTimeout(() => setSbWidth((x) => (x === w ? null : x)), 1500);
      } else {
        cmd({ type: 'ui.panel', width: w });
        setTimeout(() => setPnWidth((x) => (x === w ? null : x)), 1500);
      }
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <ContextMenuHost>
      <div className="shell grain">
        <aside className={cx('sidebar', !state.sidebar.visible && 'hidden')} style={{ width: sidebarW }}>
          {state.sidebar.visible && <Sidebar state={state} width={sidebarW} onToast={(t) => toast(t, 'success')} />}
          {state.sidebar.visible && <Toasts toasts={toasts} />}
          {state.sidebar.visible && <div className="resize-x" style={{ right: -4 }} onPointerDown={resize('sidebar')} onDoubleClick={() => cmd({ type: 'ui.sidebar', width: 248 })} />}
        </aside>

        <main className={cx('main-col', state.sidebar.visible && 'with-sidebar', state.panel.open && 'with-panel')}>
          {showTop && <TopBar state={state} tab={active} />}
          {!state.sidebar.visible && <Toasts toasts={toasts} />}
          <Banners banners={state.banners} />
          {(findOpen || state.find) && (
            <FindBar
              find={state.find}
              focusSignal={findFocus}
              onClose={() => {
                setFindOpen(false);
                cmd({ type: 'ui.focusPage' });
              }}
            />
          )}
          <Viewport state={state} />
        </main>

        {state.panel.open && (
          <aside className="panel" style={{ width: panelW }}>
            <div className="resize-x" style={{ left: 0 }} onPointerDown={resize('panel')} />
            <AgentPanel state={state} focusSignal={panelFocus} />
          </aside>
        )}
      </div>
    </ContextMenuHost>
  );
}
