// The usual browser controls behind Settings: default browser, clearing data, cookies and site data,
// site permissions, search history, duplicate tabs, and the user's browser profiles.

import { app, dialog } from 'electron';
import type { DuplicateGroup, Profile, SiteDataEntry } from '../shared/types';
import type { Clickless } from './browser';

const SEARCH_HOSTS: [RegExp, RegExp, string][] = [
  [/(^|\.)google\.[a-z.]+$/, /^\/search$/, 'Google'],
  [/(^|\.)duckduckgo\.com$/, /^\/$|^\/html\/?$/, 'DuckDuckGo'],
  [/(^|\.)bing\.com$/, /^\/search$/, 'Bing'],
  [/^search\.brave\.com$/, /^\/search$/, 'Brave'],
  [/(^|\.)kagi\.com$/, /^\/search$/, 'Kagi'],
  [/(^|\.)perplexity\.ai$/, /^\/search/, 'Perplexity'],
];

const PROFILE_COLORS = ['#5f7f75', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#ef4444', '#14b8a6', '#64748b'];

export class DataControls {
  constructor(private b: Clickless) {
    this.refreshDefault();
  }

  // ----- default browser -----

  refreshDefault() {
    try {
      this.b.defaultBrowserCache = app.isDefaultProtocolClient('https') && app.isDefaultProtocolClient('http');
    } catch {
      this.b.defaultBrowserCache = false;
    }
  }

  /** Asks the OS to make Clickless the default browser (macOS shows its own confirmation). */
  makeDefault() {
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');
    // the system may ask first; check again once it has answered
    for (const ms of [1500, 5000, 15000])
      setTimeout(() => {
        this.refreshDefault();
        this.b.pushState();
      }, ms);
  }

  async chooseDownloadFolder(): Promise<string | null> {
    const r = await dialog.showOpenDialog({ title: 'Where should downloads go?', properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Use this folder' });
    if (r.canceled || !r.filePaths[0]) return null;
    const s = this.b.state.settings;
    this.b.state.settings = { ...s, downloads: { ...s.downloads, folder: r.filePaths[0] } };
    this.b.save();
    this.b.pushState();
    return r.filePaths[0];
  }

  // ----- history and searches -----

  /** Searches you typed into search engines, newest first. */
  searchHistory(limit = 200): { query: string; engine: string; url: string; at: number }[] {
    const out: { query: string; engine: string; url: string; at: number }[] = [];
    for (const e of this.b.history.all()) {
      const s = searchOf(e.url);
      if (s) out.push({ ...s, url: e.url, at: e.lastVisitAt });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  clearSearches() {
    this.b.history.remove(this.b.history.all().filter((e) => searchOf(e.url)).map((e) => e.url));
  }

  /** Clears what the user ticked. Cookies, site data and cache have no time range in Chromium: they go entirely. */
  async clear(p: { history?: boolean; since?: number; searches?: boolean; cookies?: boolean; cache?: boolean; downloads?: boolean; permissions?: boolean }) {
    if (p.history) this.b.history.clear(p.since);
    else if (p.searches) this.clearSearches();
    for (const ses of this.b.allSessions()) {
      if (p.cookies) await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem', 'shadercache'] });
      if (p.cache) {
        await ses.clearCache();
        await ses.clearHostResolverCache();
      }
    }
    if (p.downloads) this.b.downloads = this.b.downloads.filter((d) => d.state === 'progressing');
    if (p.permissions) this.b.state.sitePermissions = {};
    this.b.save();
    this.b.pushState();
  }

  // ----- cookies and site data -----

  async siteData(): Promise<SiteDataEntry[]> {
    const by = new Map<string, number>();
    for (const ses of this.b.allSessions()) {
      for (const c of await ses.cookies.get({})) {
        const d = (c.domain ?? '').replace(/^\./, '').replace(/^www\./, '');
        if (d) by.set(d, (by.get(d) ?? 0) + 1);
      }
    }
    return [...by.entries()].map(([domain, cookies]) => ({ domain, cookies })).sort((a, b) => a.domain.localeCompare(b.domain));
  }

  /** Signs you out of a site: its cookies and stored data go, in every profile. */
  async removeSite(domain: string) {
    const d = domain.replace(/^\./, '').replace(/^www\./, '');
    for (const ses of this.b.allSessions()) {
      for (const c of await ses.cookies.get({})) {
        const cd = (c.domain ?? '').replace(/^\./, '');
        if (cd === d || cd.endsWith(`.${d}`) || cd === `www.${d}`) {
          const url = `${c.secure ? 'https' : 'http'}://${cd}${c.path ?? '/'}`;
          await ses.cookies.remove(url, c.name).catch(() => {});
        }
      }
      for (const origin of [`https://${d}`, `https://www.${d}`, `http://${d}`]) await ses.clearStorageData({ origin, storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem'] }).catch(() => {});
    }
  }

  // ----- site permissions -----

  permissions(): { origin: string; permission: string; value: 'allow' | 'deny' }[] {
    const out: { origin: string; permission: string; value: 'allow' | 'deny' }[] = [];
    for (const [origin, perms] of Object.entries(this.b.state.sitePermissions)) for (const [permission, value] of Object.entries(perms)) out.push({ origin, permission, value });
    return out.sort((a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission));
  }

  resetPermission(origin: string, permission?: string) {
    const sp = this.b.state.sitePermissions;
    if (!sp[origin]) return;
    if (permission) {
      delete sp[origin][permission];
      if (!Object.keys(sp[origin]).length) delete sp[origin];
    } else delete sp[origin];
    this.b.save();
    this.b.pushState();
  }

  // ----- duplicate tabs -----

  /** Tabs saved more than once (same address), across all spaces and folders. The first copy is the one kept. */
  duplicates(): DuplicateGroup[] {
    const st = this.b.state;
    const folders = new Map(st.folders.map((f) => [f.id, f]));
    const pathOf = (fid?: string): string => {
      const f = fid ? folders.get(fid) : undefined;
      return f ? `${pathOf(f.parentId)}${f.name} / ` : '';
    };
    const spaces = new Map(st.spaces.map((s) => [s.id, s]));
    const key = (u: string) => u.replace(/#.*$/, '').replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '');
    const groups = new Map<string, DuplicateGroup>();
    const rank = (t: { favorite: boolean; pinned: boolean }) => (t.favorite ? 0 : t.pinned ? 1 : 2);
    const all = this.b.listTabs({ all: true }).filter((t) => /^https?:/.test(t.url)).sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
    for (const t of all) {
      const k = key(t.url);
      const sp = spaces.get(t.spaceId);
      const where = t.favorite ? 'Favourites' : `${sp ? `${sp.icon} ${sp.name}` : ''}${t.folderId ? ` / ${pathOf(t.folderId).replace(/ \/ $/, '')}` : t.pinned ? '' : ' · Today'}`;
      const g = groups.get(k) ?? { url: t.url, title: t.title, tabs: [] };
      g.tabs.push({ id: t.id, where, pinned: t.pinned, favorite: t.favorite });
      groups.set(k, g);
    }
    return [...groups.values()].filter((g) => g.tabs.length > 1).sort((a, b) => b.tabs.length - a.tabs.length || a.title.localeCompare(b.title));
  }

  // ----- browser profiles -----

  createProfile(name: string): Profile {
    const list = (this.b.state.profiles ??= [{ id: 'default', name: 'Personal', color: PROFILE_COLORS[0] }]);
    const p: Profile = { id: `p${Date.now().toString(36)}`, name: name.trim().slice(0, 40) || `Profile ${list.length + 1}`, color: PROFILE_COLORS[list.length % PROFILE_COLORS.length] };
    list.push(p);
    this.b.save();
    this.b.pushState();
    return p;
  }

  updateProfile(id: string, patch: { name?: string; color?: string }) {
    const p = (this.b.state.profiles ?? []).find((x) => x.id === id);
    if (!p) return;
    if (patch.name?.trim()) p.name = patch.name.trim().slice(0, 40);
    if (patch.color) p.color = patch.color;
    this.b.save();
    this.b.pushState();
  }

  /** Deletes a profile and everything it stored (cookies, logins, site data); its spaces move to the default profile. */
  async deleteProfile(id: string) {
    if (id === 'default') throw new Error('The default profile can’t be deleted.');
    const ses = this.b.sessionFor(id);
    for (const s of this.b.state.spaces) if (s.profileId === id) this.b.setSpaceProfile(s.id, undefined);
    await ses.clearStorageData().catch(() => {});
    await ses.clearCache().catch(() => {});
    this.b.state.profiles = (this.b.state.profiles ?? []).filter((x) => x.id !== id);
    this.b.save();
    this.b.pushState();
  }
}

function searchOf(url: string): { query: string; engine: string } | null {
  try {
    const u = new URL(url);
    for (const [host, p, engine] of SEARCH_HOSTS) {
      if (!host.test(u.hostname) || !p.test(u.pathname)) continue;
      const q = u.searchParams.get('q')?.trim();
      if (q) return { query: q, engine };
    }
  } catch {
    /* not a URL */
  }
  return null;
}
