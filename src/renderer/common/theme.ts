import { useEffect } from 'react';
import type { UIState } from '../../shared/types';

/** Applies the theme override and the active space colour to :root. */
export function useTheme(state: UIState | null) {
  const theme = state?.settings.appearance.theme ?? 'system';
  const color = state?.spaces.find((s) => s.id === state.activeSpaceId)?.color;
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (color) document.documentElement.style.setProperty('--space', color);
  }, [color]);
  const tint = state?.settings.appearance.tint ?? 'standard';
  const size = state?.settings.appearance.sidebarSize ?? 'standard';
  useEffect(() => {
    document.documentElement.style.setProperty('--tint', String({ subtle: 0.45, standard: 1, vivid: 1.9 }[tint] ?? 1));
  }, [tint]);
  useEffect(() => {
    document.documentElement.dataset.sbsize = size;
  }, [size]);
  useEffect(() => {
    document.documentElement.dataset.platform = state?.platform ?? window.clickless?.platform ?? 'darwin';
  }, [state?.platform]);
}
