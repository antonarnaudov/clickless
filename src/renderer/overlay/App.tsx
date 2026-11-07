import { useEffect } from 'react';
import { cmd, useUIState } from '../common/api';
import { useTheme } from '../common/theme';
import { Organizer } from './Organizer';
import { Palette } from './Palette';
import { Settings } from './Settings';
import { SpaceEditor } from './SpaceEditor';

export function App() {
  const state = useUIState();
  useTheme(state);
  const overlay = state?.overlay ?? null;

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && overlay) {
        e.preventDefault();
        cmd({ type: 'ui.overlay', overlay: null });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [overlay]);

  if (!state || !overlay) return null;
  const close = () => cmd({ type: 'ui.overlay', overlay: null });

  return (
    <>
      <div className="scrim" onMouseDown={close} style={overlay.kind === 'palette' ? { background: 'color-mix(in oklch, var(--scrim) 60%, transparent)' } : undefined} />
      {overlay.kind === 'palette' && <Palette key="palette" overlay={overlay} state={state} />}
      {overlay.kind === 'settings' && <Settings key="settings" overlay={overlay} state={state} />}
      {overlay.kind === 'organize' && <Organizer key="organize" overlay={overlay} state={state} />}
      {overlay.kind === 'space' && <SpaceEditor key={`space-${overlay.spaceId ?? 'new'}`} overlay={overlay} state={state} />}
    </>
  );
}
