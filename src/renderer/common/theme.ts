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
  useEffect(() => {
    document.documentElement.dataset.platform = state?.platform ?? window.clickless?.platform ?? 'darwin';
  }, [state?.platform]);
}
