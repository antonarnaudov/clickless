// Persistence: browser state (spaces, tabs, folders, settings), history, encrypted secrets,
// and the discovery file external agents use to find the control API.

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { ArchivedTab, Folder, HistoryEntry, Settings, Space, Tab } from '../shared/types';

export interface PersistedTab
  extends Pick<Tab, 'id' | 'spaceId' | 'url' | 'title' | 'favicon' | 'favorite' | 'pinned' | 'folderId' | 'order' | 'createdAt' | 'lastActiveAt' | 'zoom' | 'muted'> {}

export interface PersistedState {
  version: 1;
  nextTab: number;
  spaces: Space[];
  activeSpaceId: string;
  tabs: PersistedTab[];
  folders: Folder[];
  activeTabBySpace: Record<string, string>;
  sidebar: { visible: boolean; width: number };
  panel: { open: boolean; width: number };
  archived: ArchivedTab[];
  settings: Settings;
  sitePermissions: Record<string, Record<string, 'allow' | 'deny'>>;
  /** Recently closed tabs, newest last, for ⇧⌘T and History → Recently Closed. */
  closed?: ClosedTab[];
}

export interface ClosedTab extends PersistedTab {
  closedAt: number;
  /** The tab's own back/forward list, restored on reopen. */
  nav?: { entries: { url: string; title: string }[]; index: number };
}

export const dataDir = () => app.getPath('userData');
/** ~/.clickless, or CLICKLESS_HOME (lets a test copy run next to the real one). */
export const discoveryDir = () => (process.env.CLICKLESS_HOME ? path.resolve(process.env.CLICKLESS_HOME) : path.join(os.homedir(), '.clickless'));
export const discoveryFile = () => path.join(discoveryDir(), 'control.json');

function readJSON<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, data: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

function mergeSettings(saved: Partial<Settings> | undefined): Settings {
  const s = saved ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    control: { ...DEFAULT_SETTINGS.control, ...(s.control ?? {}) },
    agent: { ...DEFAULT_SETTINGS.agent, ...(s.agent ?? {}) },
    tabs: { ...DEFAULT_SETTINGS.tabs, ...(s.tabs ?? {}) },
    backup: { ...DEFAULT_SETTINGS.backup, ...(s.backup ?? {}) },
    appearance: { ...DEFAULT_SETTINGS.appearance, ...(s.appearance ?? {}) },
    providers: s.providers ?? [],
  };
}

export function defaultState(): PersistedState {
  const personal: Space = { id: 's1', name: 'Personal', icon: '🌿', color: '#5f7f75' };
  const work: Space = { id: 's2', name: 'Work', icon: '💼', color: '#2bb5a0' };
  return {
    version: 1,
    nextTab: 1,
    spaces: [personal, work],
    activeSpaceId: personal.id,
    tabs: [],
    folders: [],
    activeTabBySpace: {},
    sidebar: { visible: true, width: 260 },
    panel: { open: false, width: 380 },
    archived: [],
    settings: mergeSettings(undefined),
    sitePermissions: {},
  };
}

/** Synchronous read, usable before app 'ready' (e.g. to set the CDP port switch). */
export function loadState(): PersistedState {
  const file = path.join(dataDir(), 'state.json');
  const saved = readJSON<PersistedState>(file);
  if (!saved || saved.version !== 1 || !Array.isArray(saved.spaces) || !saved.spaces.length) return defaultState();
  const base = defaultState();
  return {
    ...base,
    ...saved,
    settings: mergeSettings(saved.settings),
    sidebar: { ...base.sidebar, ...(saved.sidebar ?? {}) },
    panel: { ...base.panel, ...(saved.panel ?? {}) },
    archived: saved.archived ?? [],
    folders: saved.folders ?? [],
    sitePermissions: saved.sitePermissions ?? {},
    closed: Array.isArray(saved.closed) ? saved.closed.slice(-30) : [],
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: (() => PersistedState) | null = null;

export function saveStateSoon(get: () => PersistedState) {
  pending = get;
  if (saveTimer) return;
  saveTimer = setTimeout(flushState, 400);
}

export function flushState() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!pending) return;
  try {
    writeAtomic(path.join(dataDir(), 'state.json'), JSON.stringify(pending(), null, 1));
  } catch (err) {
    console.error('[store] save failed', err);
  }
  pending = null;
}

// ---------- history ----------

export class History {
  private map = new Map<string, HistoryEntry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private file = path.join(dataDir(), 'history.json');

  constructor() {
    const list = readJSON<HistoryEntry[]>(this.file) ?? [];
    for (const e of list) this.map.set(e.url, e);
  }

  add(url: string, title: string, favicon?: string) {
    if (!/^https?:/.test(url)) return;
    const e = this.map.get(url);
    if (e) {
      e.visitCount++;
      e.lastVisitAt = Date.now();
      if (title) e.title = title;
      if (favicon) e.favicon = favicon;
      this.map.delete(url);
      this.map.set(url, e);
    } else this.map.set(url, { url, title: title || url, favicon, visitCount: 1, lastVisitAt: Date.now() });
    if (this.map.size > 10000) {
      const first = this.map.keys().next().value;
      if (first) this.map.delete(first);
    }
    this.saveSoon();
  }

  update(url: string, patch: { title?: string; favicon?: string }) {
    const e = this.map.get(url);
    if (!e) return;
    if (patch.title) e.title = patch.title;
    if (patch.favicon) e.favicon = patch.favicon;
    this.saveSoon();
  }

  /** Forgets these addresses. */
  remove(urls: string[]) {
    for (const u of urls) this.map.delete(u);
    this.saveSoon();
  }

  /** Forgets everything visited since `since` (ms), or everything. */
  clear(since?: number) {
    if (!since) this.map.clear();
    else for (const [u, e] of this.map) if (e.lastVisitAt >= since) this.map.delete(u);
    this.flush();
  }

  all(): HistoryEntry[] {
    return Array.from(this.map.values());
  }

  search(query: string, limit = 20): HistoryEntry[] {
    const q = query.trim().toLowerCase();
    const all = Array.from(this.map.values());
    if (!q) return all.sort((a, b) => b.lastVisitAt - a.lastVisitAt).slice(0, limit);
    const now = Date.now();
    const scored: { e: HistoryEntry; s: number }[] = [];
    for (const e of all) {
      const url = e.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
      const title = e.title.toLowerCase();
      let s = 0;
      if (url.startsWith(q)) s += 60;
      else if (url.includes(q)) s += 25;
      if (title.startsWith(q)) s += 40;
      else if (title.includes(q)) s += 20;
      if (!s) continue;
      s += Math.min(30, Math.log2(1 + e.visitCount) * 6);
      s -= Math.min(20, (now - e.lastVisitAt) / 86400000 / 3);
      scored.push({ e, s });
    }
    return scored
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.e);
  }

  private saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 2000);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      writeAtomic(this.file, JSON.stringify(Array.from(this.map.values())));
    } catch (err) {
      console.error('[history] save failed', err);
    }
  }
}

/**
 * Restores a backup: the current state and history are kept as `*.before-restore.json`, then the
 * backup's are written. The caller relaunches the app right after (nothing else may save first).
 */
export function replaceData(state: PersistedState, history: HistoryEntry[]) {
  const dir = dataDir();
  for (const f of ['state.json', 'history.json']) {
    const cur = path.join(dir, f);
    if (fs.existsSync(cur)) fs.copyFileSync(cur, path.join(dir, f.replace('.json', '.before-restore.json')));
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  pending = null;
  writeAtomic(path.join(dir, 'state.json'), JSON.stringify(state, null, 1));
  writeAtomic(path.join(dir, 'history.json'), JSON.stringify(history));
}

// ---------- secrets ----------

export class Secrets {
  private file = path.join(dataDir(), 'secrets.json');
  private data: Record<string, string> = {};

  constructor() {
    this.data = readJSON<Record<string, string>>(this.file) ?? {};
  }

  get(key: string): string | undefined {
    const v = this.data[key];
    if (!v) return undefined;
    try {
      if (v.startsWith('enc:') && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
      if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
    } catch (err) {
      console.error('[secrets] decrypt failed for', key, err);
    }
    return undefined;
  }

  set(key: string, value: string | null) {
    if (value === null || value === '') delete this.data[key];
    else if (safeStorage.isEncryptionAvailable()) this.data[key] = 'enc:' + safeStorage.encryptString(value).toString('base64');
    else this.data[key] = 'raw:' + Buffer.from(value, 'utf8').toString('base64');
    writeAtomic(this.file, JSON.stringify(this.data), 0o600);
  }

  has(key: string) {
    return !!this.data[key];
  }

  /** The control API token, created on first use. */
  controlToken(regenerate = false): string {
    let t = regenerate ? undefined : this.get('control.token');
    if (!t) {
      t = 'clickless_' + crypto.randomBytes(24).toString('base64url');
      this.set('control.token', t);
    }
    return t;
  }
}

export function writeDiscovery(info: Record<string, unknown> | null) {
  const file = discoveryFile();
  if (!info) {
    try {
      const cur = readJSON<{ pid?: number }>(file);
      if (cur?.pid === process.pid) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    return;
  }
  fs.mkdirSync(discoveryDir(), { recursive: true, mode: 0o700 });
  writeAtomic(file, JSON.stringify(info, null, 2), 0o600);
}
