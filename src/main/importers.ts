// Import tabs, folders and spaces from other browsers on this Mac: Arc (spaces, pinned tabs,
// folders, favourites, Today) and Chromium browsers — Comet, Chrome, Brave, Edge — (open tabs
// from the last session + bookmarks). Only URLs, titles and structure are read: never passwords,
// cookies or history.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImportReport, ImportSource } from '../shared/types';

export type { ImportReport, ImportSource };

export type ImportNode = { kind: 'tab'; url: string; title: string; favicon?: string } | { kind: 'folder'; name: string; children: ImportNode[] };

export interface ImportSpace {
  /** Matched to an existing space by name ("Work Space" → "Work"), otherwise created. */
  name: string;
  icon: string;
  favorites: ImportNode[];
  pinned: ImportNode[];
  today: ImportNode[];
}

export interface ImportPlan {
  source: string;
  spaces: ImportSpace[];
}

const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support');

const CHROMIUM: Record<string, { name: string; dir: string; icon: string }> = {
  comet: { name: 'Comet', dir: path.join(SUPPORT, 'Comet'), icon: '☄️' },
  chrome: { name: 'Chrome', dir: path.join(SUPPORT, 'Google', 'Chrome'), icon: '🌐' },
  brave: { name: 'Brave', dir: path.join(SUPPORT, 'BraveSoftware', 'Brave-Browser'), icon: '🦁' },
  edge: { name: 'Edge', dir: path.join(SUPPORT, 'Microsoft Edge'), icon: '🌊' },
};
const ARC_DIR = path.join(SUPPORT, 'Arc');
const ARC_PROFILE = path.join(ARC_DIR, 'User Data', 'Default');

export function listSources(): ImportSource[] {
  const out: ImportSource[] = [{ id: 'arc', name: 'Arc', available: fs.existsSync(path.join(ARC_DIR, 'StorableSidebar.json')) }];
  for (const [id, c] of Object.entries(CHROMIUM)) out.push({ id, name: c.name, available: fs.existsSync(path.join(c.dir, 'Default')) });
  return out;
}

export function readSource(id: string): ImportPlan {
  if (id === 'arc') return withFavicons(readArc(), path.join(ARC_PROFILE, 'Favicons'));
  const c = CHROMIUM[id];
  if (!c) throw new Error(`Unknown browser “${id}”. Try: ${listSources().map((s) => s.id).join(', ')}`);
  const profile = path.join(c.dir, 'Default');
  return withFavicons(readChromium(c.name, profile, c.icon), path.join(profile, 'Favicons'));
}

const skipUrl = (u: string) => !u || /^(chrome|comet|arc|edge|brave|about|chrome-extension|devtools|view-source):/i.test(u);

// ---------------------------------------------------------------------------
// Arc: ~/Library/Application Support/Arc/StorableSidebar.json
// ---------------------------------------------------------------------------

/** Arc stores id/object pairs in flat arrays: [id, {…}, id, {…}]. */
function pairs<T = any>(arr: unknown[]): Map<string, T> {
  const m = new Map<string, T>();
  for (let i = 0; i + 1 < arr.length; i += 2) if (typeof arr[i] === 'string' && arr[i + 1] && typeof arr[i + 1] === 'object') m.set(arr[i] as string, arr[i + 1] as T);
  return m;
}

const SF_ICONS: Record<string, string> = { terminal: '💻', briefcase: '💼', house: '🏠', star: '⭐', heart: '❤️', book: '📚', gamecontroller: '🎮', cart: '🛒', globe: '🌐', sparkles: '✨' };

function arcIcon(space: any): string {
  const t = space?.customInfo?.iconType ?? {};
  if (typeof t.emoji_v2 === 'string') return t.emoji_v2;
  if (typeof t.emoji === 'number') return String.fromCodePoint(t.emoji);
  if (typeof t.emoji === 'string') return t.emoji;
  if (typeof t.icon === 'string') return SF_ICONS[t.icon.split('.')[0]] ?? '✨';
  return '✨';
}

export function readArc(file = path.join(ARC_DIR, 'StorableSidebar.json')): ImportPlan {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sidebar = raw.sidebar ?? raw;
  const main = (sidebar.containers ?? []).find((c: any) => Array.isArray(c?.spaces));
  if (!main) throw new Error('Arc sidebar has no spaces');
  const items = pairs<any>(main.items ?? []);
  const spaces = pairs<any>(main.spaces ?? []);

  /** One sidebar item → nodes. Split views are flattened into their tabs; easels (canvases) are skipped. */
  const nodes = (id: string): ImportNode[] => {
    const it = items.get(id);
    if (!it) return [];
    const d = it.data ?? {};
    const kids = () => ((it.childrenIds ?? []) as string[]).flatMap(nodes);
    if (d.tab) {
      const url = d.tab.savedURL ?? '';
      return skipUrl(url) ? [] : [{ kind: 'tab', url, title: it.title || d.tab.savedTitle || url }];
    }
    if (d.list) return [{ kind: 'folder', name: it.title || 'Folder', children: kids() }];
    if (d.splitView || d.itemContainer) return kids();
    return [];
  };
  const container = (id: string | undefined): ImportNode[] => (id ? nodes(id) : []);

  const out: ImportSpace[] = [];
  for (const s of spaces.values()) {
    const ids: unknown[] = s.containerIDs ?? [];
    const c: Record<string, string> = {};
    for (let i = 0; i + 1 < ids.length; i += 2) if (typeof ids[i] === 'string') c[ids[i] as string] = ids[i + 1] as string;
    out.push({ name: s.title || 'Arc', icon: arcIcon(s), favorites: [], pinned: container(c.pinned), today: container(c.unpinned) });
  }
  // Favourites are global in Arc (top apps): give them to the first space; Clickless shows them everywhere.
  const favIds = (main.topAppsContainerIDs ?? []).filter((x: unknown) => typeof x === 'string') as string[];
  const favorites = favIds.flatMap((id) => container(id));
  if (out.length) out[0].favorites = favorites;
  return { source: 'Arc', spaces: out };
}

// ---------------------------------------------------------------------------
// Chromium browsers: Default/Bookmarks (JSON) + the latest Sessions/Session_* (SNSS)
// ---------------------------------------------------------------------------

export function readChromium(name: string, profile: string, icon = '🌐'): ImportPlan {
  const pinned: ImportNode[] = [];
  try {
    const b = JSON.parse(fs.readFileSync(path.join(profile, 'Bookmarks'), 'utf8'));
    const conv = (n: any): ImportNode | null => {
      if (n.type === 'url') return skipUrl(n.url) ? null : { kind: 'tab', url: n.url, title: n.name || n.url };
      if (n.type === 'folder') return { kind: 'folder', name: n.name || 'Folder', children: (n.children ?? []).map(conv).filter(Boolean) };
      return null;
    };
    for (const n of b.roots?.bookmark_bar?.children ?? []) {
      const c = conv(n);
      if (c) pinned.push(c);
    }
    const other = (b.roots?.other?.children ?? []).map(conv).filter(Boolean) as ImportNode[];
    if (other.length) pinned.push({ kind: 'folder', name: 'Other bookmarks', children: other });
  } catch {
    /* no bookmarks */
  }
  // Open tabs go into a pinned folder, not Today: Today tabs auto-archive after a few hours, and
  // these were never meant to expire.
  const open = readSessionTabs(path.join(profile, 'Sessions'));
  if (open.length) pinned.unshift({ kind: 'folder', name: 'Open tabs', children: open });
  return { source: name, spaces: [{ name, icon, favorites: [], pinned, today: [] }] };
}

/** Open tabs of the last session, in window and tab order, from Chromium's SNSS session log. */
export function readSessionTabs(sessionsDir: string): ImportNode[] {
  let file: string | null = null;
  try {
    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.startsWith('Session_'))
      .map((f) => path.join(sessionsDir, f))
      .filter((f) => fs.statSync(f).size > 8);
    file = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
  } catch {
    return [];
  }
  if (!file) return [];
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'SNSS') return [];
  const navs = new Map<number, Map<number, { url: string; title: string }>>();
  const selected = new Map<number, number>();
  const closed = new Set<number>();
  const closedWindows = new Set<number>();
  const windowOf = new Map<number, number>();
  const indexOf = new Map<number, number>();
  const firstSeen = new Map<number, number>();
  let seq = 0;
  const str = (p: Buffer, o: number): [string, number] => {
    const n = p.readInt32LE(o);
    o += 4;
    return [p.toString('utf8', o, o + n), o + ((n + 3) & ~3)];
  };
  const str16 = (p: Buffer, o: number): [string, number] => {
    const n = p.readInt32LE(o);
    o += 4;
    return [p.toString('utf16le', o, o + 2 * n), o + ((2 * n + 3) & ~3)];
  };
  let pos = 8;
  while (pos + 3 <= b.length) {
    const size = b.readUInt16LE(pos);
    const id = b[pos + 2];
    const p = b.subarray(pos + 3, pos + 2 + size);
    pos += 2 + size;
    try {
      switch (id) {
        case 6: {
          // UpdateTabNavigation: pickle header, tab id, navigation index, url, title, …
          const tab = p.readInt32LE(4);
          const ni = p.readInt32LE(8);
          const [url, o] = str(p, 12);
          const [title] = str16(p, o);
          if (!navs.has(tab)) navs.set(tab, new Map());
          navs.get(tab)!.set(ni, { url, title });
          if (!firstSeen.has(tab)) firstSeen.set(tab, seq++);
          break;
        }
        case 7:
          selected.set(p.readInt32LE(0), p.readInt32LE(4));
          break;
        case 16:
          closed.add(p.readInt32LE(0));
          break;
        case 17:
          closedWindows.add(p.readInt32LE(0));
          break;
        case 0:
          windowOf.set(p.readInt32LE(4), p.readInt32LE(0));
          break;
        case 2:
          indexOf.set(p.readInt32LE(0), p.readInt32LE(4));
          break;
      }
    } catch {
      /* truncated record */
    }
  }
  const open = [...navs.keys()].filter((t) => !closed.has(t) && !closedWindows.has(windowOf.get(t) ?? -1));
  open.sort((a, b) => (windowOf.get(a) ?? 0) - (windowOf.get(b) ?? 0) || (indexOf.get(a) ?? firstSeen.get(a) ?? 0) - (indexOf.get(b) ?? firstSeen.get(b) ?? 0));
  const out: ImportNode[] = [];
  for (const t of open) {
    const m = navs.get(t)!;
    const keys = [...m.keys()];
    const e = m.get(selected.get(t) ?? Math.max(...keys)) ?? m.get(Math.max(...keys))!;
    if (skipUrl(e.url)) continue;
    out.push({ kind: 'tab', url: e.url, title: e.title || e.url });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Favicons: Chromium's Favicons SQLite database, read from a temporary copy (the browser may be
// running and holding a lock). Imported tabs are asleep, so without this they'd show letters until
// each page is opened.
// ---------------------------------------------------------------------------

const hostKey = (u: string) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export function withFavicons(plan: ImportPlan, dbFile: string): ImportPlan {
  const tabs: Extract<ImportNode, { kind: 'tab' }>[] = [];
  const walk = (n: ImportNode) => (n.kind === 'tab' ? tabs.push(n) : n.children.forEach(walk));
  for (const s of plan.spaces) [...s.favorites, ...s.pinned, ...s.today].forEach(walk);
  if (!tabs.length || !fs.existsSync(dbFile)) return plan;
  let tmp: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clickless-fav-')), 'Favicons');
    fs.copyFileSync(dbFile, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    // best bitmap per icon: 32px first (sharp on Retina at 16pt), then the closest size
    const rank = (w: number) => (w === 32 ? 0 : w > 32 ? w - 32 : 100 + (32 - w));
    const best = new Map<number, { id: number; r: number }>();
    for (const row of db.prepare('SELECT id, icon_id, width FROM favicon_bitmaps WHERE width > 0 AND length(image_data) > 0').all() as { id: number; icon_id: number; width: number }[]) {
      const r = rank(row.width);
      const cur = best.get(row.icon_id);
      if (!cur || r < cur.r) best.set(row.icon_id, { id: row.id, r });
    }
    const byUrl = new Map<string, number>();
    const byHost = new Map<string, number>();
    for (const row of db.prepare('SELECT page_url, icon_id FROM icon_mapping').all() as { page_url: string; icon_id: number }[]) {
      if (!best.has(row.icon_id)) continue;
      byUrl.set(row.page_url, row.icon_id);
      const h = hostKey(row.page_url);
      if (h && !byHost.has(h)) byHost.set(h, row.icon_id);
    }
    const blob = db.prepare('SELECT image_data FROM favicon_bitmaps WHERE id = ?');
    const cache = new Map<number, string | null>();
    for (const t of tabs) {
      const icon = byUrl.get(t.url) ?? byHost.get(hostKey(t.url));
      if (icon === undefined) continue;
      if (!cache.has(icon)) {
        const data = (blob.get(best.get(icon)!.id) as { image_data?: Uint8Array } | undefined)?.image_data;
        cache.set(icon, data && data.length < 64 * 1024 ? `data:image/png;base64,${Buffer.from(data).toString('base64')}` : null);
      }
      const uri = cache.get(icon);
      if (uri) t.favicon = uri;
    }
    db.close();
  } catch {
    /* favicons are a nicety: letters are fine */
  } finally {
    if (tmp) fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
  return plan;
}

export function countPlan(plan: ImportPlan): { tabs: number; folders: number } {
  let tabs = 0;
  let folders = 0;
  const walk = (n: ImportNode) => {
    if (n.kind === 'tab') tabs++;
    else {
      folders++;
      n.children.forEach(walk);
    }
  };
  for (const s of plan.spaces) [...s.favorites, ...s.pinned, ...s.today].forEach(walk);
  return { tabs, folders };
}
