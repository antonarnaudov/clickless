import type { Folder, Tab, UIState } from '../../shared/types';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'clickless:') return u.host || u.pathname.replace(/^\/+/, '').split(/[/?#]/)[0];
    return u.host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function isSecure(url: string | undefined): boolean {
  return !!url && /^https:/.test(url);
}

export function displayUrl(url: string | undefined): string {
  if (!url) return '';
  if (/^clickless:\/\/newtab/.test(url)) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'clickless:') return `clickless://${hostOf(url)}`;
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host.replace(/^www\./, '')}${path}${u.search}`;
  } catch {
    return url;
  }
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function formatBytes(n: number): string {
  if (!n || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

/** Stable pastel-ish colour for letter avatars. */
export function letterColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `oklch(0.62 0.13 ${h % 360})`;
}

export const isMac = () => (window.clickless?.platform ?? 'darwin') === 'darwin';
export const mod = () => (isMac() ? '⌘' : 'Ctrl+');

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ---------- sidebar model ----------

export type SectionItem = { kind: 'tab'; tab: Tab } | { kind: 'folder'; folder: Folder; tabs: Tab[] };

export interface SidebarModel {
  favorites: Tab[];
  pinned: SectionItem[];
  today: SectionItem[];
  /** Flat, visible order: favorites, pinned, today (folders expanded). Used for ⌘1–9 and cycling. */
  flat: Tab[];
}

const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;

export function buildSidebar(state: Pick<UIState, 'tabs' | 'folders' | 'activeSpaceId'>): SidebarModel {
  const favorites = state.tabs.filter((t) => t.favorite).sort(byOrder);
  const inSpace = state.tabs.filter((t) => !t.favorite && t.spaceId === state.activeSpaceId);
  const folders = state.folders.filter((f) => f.spaceId === state.activeSpaceId);
  const folderIds = new Set(folders.map((f) => f.id));
  const section = (pinned: boolean): SectionItem[] => {
    const items: (SectionItem & { order: number })[] = [];
    for (const f of folders) {
      if (f.pinned !== pinned) continue;
      items.push({ kind: 'folder', folder: f, tabs: inSpace.filter((t) => t.folderId === f.id).sort(byOrder), order: f.order });
    }
    for (const t of inSpace) {
      if (t.pinned !== pinned) continue;
      if (t.folderId && folderIds.has(t.folderId)) continue;
      items.push({ kind: 'tab', tab: t, order: t.order });
    }
    return items.sort(byOrder);
  };
  const pinned = section(true);
  const today = section(false);
  const flat: Tab[] = [...favorites];
  for (const it of [...pinned, ...today]) {
    if (it.kind === 'tab') flat.push(it.tab);
    else if (!it.folder.collapsed) flat.push(...it.tabs);
  }
  return { favorites, pinned, today, flat };
}

/** Structural sharing: reuse `prev` sub-objects that are deep-equal to `next`, so React.memo works on IPC payloads. */
export function share<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (typeof prev !== 'object' || typeof next !== 'object' || prev === null || next === null) return next;
  if (Array.isArray(prev) !== Array.isArray(next)) return next;
  if (Array.isArray(prev) && Array.isArray(next)) {
    // Arrays of objects with ids: match by id so reordering keeps identities.
    const prevById = new Map<unknown, unknown>();
    for (const p of prev) if (p && typeof p === 'object' && 'id' in p) prevById.set((p as { id: unknown }).id, p);
    let same = prev.length === next.length;
    const out = next.map((n, i) => {
      const match = n && typeof n === 'object' && 'id' in n ? prevById.get((n as { id: unknown }).id) : prev[i];
      const v = match === undefined ? n : share(match, n);
      if (v !== prev[i]) same = false;
      return v;
    });
    return (same ? prev : out) as T;
  }
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const pk = Object.keys(p);
  const nk = Object.keys(n);
  let same = pk.length === nk.length;
  const out: Record<string, unknown> = {};
  for (const k of nk) {
    const v = share(p[k], n[k]);
    out[k] = v;
    if (v !== p[k]) same = false;
  }
  return (same ? prev : out) as T;
}
