// IPC from the shell, the overlay and internal pages → browser actions.

import { ipcMain, nativeTheme, net, type IpcMainInvokeEvent } from 'electron';
import { INTERNAL_PAGE_COMMANDS, INTERNAL_PAGE_QUERIES, IPC, type Command, type DeepPartial, type QueryMap, type QueryName } from '../shared/ipc';
import { SEARCH_ENGINES } from '../shared/settings';
import type { ProviderConfig, Settings, Suggestion } from '../shared/types';
import type { Clickless } from './browser';
import { listSources } from './importers';

export interface IpcApp {
  browser: Clickless;
  restartControl(): Promise<void>;
  controlSecrets(): QueryMap['controlSecrets']['result'];
  regenerateToken(): void;
}

function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (!patch || typeof patch !== 'object') return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v as any);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

const looksLikeUrl = (s: string) =>
  /^(https?|file|clickless|about):/i.test(s) || /^localhost(:\d+)?/i.test(s) || (!/\s/.test(s) && /^[^/?#\s]+\.[a-z]{2,24}(:\d+)?([/?#].*)?$/i.test(s));

async function remoteSuggestions(q: string): Promise<string[]> {
  try {
    const r = await net.fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`, { signal: AbortSignal.timeout(600) });
    const j = (await r.json()) as [string, string[]];
    return Array.isArray(j?.[1]) ? j[1].filter((s) => s.toLowerCase() !== q.toLowerCase()).slice(0, 4) : [];
  } catch {
    return [];
  }
}

export function registerIpc(app: IpcApp) {
  const b = app.browser;

  async function suggest(input: string, limit = 10): Promise<Suggestion[]> {
    const q = input.trim();
    const st = b.state.settings;
    const engineLabel = st.searchEngine === 'custom' ? 'the web' : SEARCH_ENGINES[st.searchEngine as keyof typeof SEARCH_ENGINES]?.label ?? 'Google';
    const spaceName = (id: string) => b.state.spaces.find((s) => s.id === id)?.name ?? '';
    const tabs = b.listTabs({ all: true }).filter((t) => !t.internal);
    if (!q) {
      return tabs
        .filter((t) => t.id !== b.activeTabId())
        .sort((x, y) => y.lastActiveAt - x.lastActiveAt)
        .slice(0, 6)
        .map((t) => ({ kind: 'tab', title: t.title, subtitle: `${spaceName(t.spaceId)} · ${t.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}`, tabId: t.id, url: t.url, favicon: t.favicon }));
    }
    const lower = q.toLowerCase();
    const out: Suggestion[] = [];
    const urlLike = looksLikeUrl(q);
    if (urlLike) out.push({ kind: 'url', title: q, subtitle: 'Open', url: b.toUrl(q) });
    const tabHits = tabs
      .filter((t) => t.title.toLowerCase().includes(lower) || t.url.toLowerCase().includes(lower))
      .slice(0, 3)
      .map<Suggestion>((t) => ({ kind: 'tab', title: t.title, subtitle: `Switch to tab · ${spaceName(t.spaceId)}`, tabId: t.id, url: t.url, favicon: t.favicon }));
    out.push(...tabHits);
    if (!urlLike) out.push({ kind: 'search', title: q, subtitle: `Search ${engineLabel}`, url: b.searchUrl(q) });
    out.push({ kind: 'ask', title: q, subtitle: 'Ask AI — search the web and answer with sources' });
    const openUrls = new Set(tabs.map((t) => t.url));
    for (const h of b.history.search(q, 6)) {
      if (openUrls.has(h.url)) continue;
      out.push({ kind: 'history', title: h.title, subtitle: h.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 70), url: h.url, favicon: h.favicon });
    }
    for (const a of b.state.archived.filter((a) => a.title.toLowerCase().includes(lower) || a.url.toLowerCase().includes(lower)).slice(0, 2)) {
      out.push({ kind: 'archived', title: a.title, subtitle: 'Archived tab', url: a.url, archivedId: a.id, favicon: a.favicon });
    }
    if (!urlLike && q.length >= 2 && b.state.settings.searchSuggestions) {
      for (const s of await remoteSuggestions(q)) out.push({ kind: 'search', title: s, subtitle: `Search ${engineLabel}`, url: b.searchUrl(s) });
    }
    return out.slice(0, limit);
  }

  async function runCommand(c: Command): Promise<unknown> {
    switch (c.type) {
      // tabs
      case 'tab.new':
        return (await b.openTab(c.url ?? 'clickless://newtab', { background: c.background, spaceId: c.spaceId, pinned: c.pinned, folderId: c.folderId })).id;
      case 'tab.activate':
        return b.activateTab(c.tabId);
      case 'tab.close':
        return b.closeTab(c.tabId);
      case 'tab.delete':
        return b.closeTab(c.tabId, { remove: true });
      case 'tab.navigate': {
        const id = c.tabId ?? b.activeTabId();
        if (!id) return (await b.openTab(c.input)).id;
        const wc = b.wcOf(id);
        wc?.loadURL(b.toUrl(c.input)).catch(() => {});
        wc?.focus();
        return id;
      }
      case 'tab.back':
        return b.wcOf(c.tabId)?.navigationHistory.goBack();
      case 'tab.forward':
        return b.wcOf(c.tabId)?.navigationHistory.goForward();
      case 'tab.reload': {
        const wc = b.wcOf(c.tabId);
        return c.hard ? wc?.reloadIgnoringCache() : wc?.reload();
      }
      case 'tab.stop':
        return b.wcOf(c.tabId)?.stop();
      case 'tab.update':
        return b.updateTab(c.tabId, c.patch);
      case 'tab.move':
        return b.moveTab(c.tabId, c);
      case 'tab.duplicate':
        return b.duplicateTab(c.tabId);
      case 'tab.reopenClosed':
        return b.reopenClosed(c.closedId);
      case 'ui.history':
        return b.openHistory();
      case 'history.delete':
        b.history.remove(c.urls ?? []);
        return;
      case 'history.clear':
        b.history.clear(c.since);
        return;
      case 'tab.restoreArchived':
        return b.restoreArchived(c.archivedId);
      case 'tabs.clearToday':
        return b.clearToday(c.spaceId);
      case 'tabs.cycle':
        return b.cycleTabs(c.dir);
      case 'tabs.activateIndex': {
        const order = b.sidebarOrder();
        const t = c.index >= 8 ? order[order.length - 1] : order[c.index];
        return t && b.activateTab(t.id);
      }
      // folders
      case 'folder.create':
        return b.createFolder(c);
      case 'folder.update': {
        const f = b.state.folders.find((x) => x.id === c.folderId);
        if (f) {
          const { color, icon, ...rest } = c.patch;
          Object.assign(f, rest);
          if (color !== undefined) f.color = color || undefined;
          if (icon !== undefined) f.icon = icon || undefined;
        }
        b.save();
        b.layout();
        return b.pushState();
      }
      case 'folder.delete':
        return b.deleteFolder(c.folderId, c.closeTabs);
      case 'folder.move':
        return b.moveFolder(c.folderId, c);
      case 'folder.nest':
        return b.nestFolder(c.folderId, c.parentId);
      // spaces
      case 'space.create':
        return b.createSpace(c);
      case 'space.update': {
        const s = b.state.spaces.find((x) => x.id === c.spaceId);
        if (s) Object.assign(s, c.patch);
        b.save();
        return b.pushState();
      }
      case 'space.delete':
        return b.deleteSpace(c.spaceId);
      case 'space.activate':
        return b.activateSpace(c.spaceId);
      case 'space.cycle': {
        const list = b.state.spaces;
        const i = list.findIndex((s) => s.id === b.state.activeSpaceId);
        return b.activateSpace(list[(i + c.dir + list.length) % list.length].id);
      }
      // layout
      case 'ui.viewports':
        return b.setViewports(c.rects);
      case 'ui.sidebar':
        if (c.visible !== undefined) b.state.sidebar.visible = c.visible;
        if (c.width !== undefined) b.state.sidebar.width = Math.max(200, Math.min(480, c.width));
        b.save();
        b.layout();
        return b.pushState();
      case 'ui.panel':
        if (c.open !== undefined) b.state.panel.open = c.open;
        if (c.width !== undefined) b.state.panel.width = Math.max(300, Math.min(720, c.width));
        b.save();
        b.layout();
        b.pushState();
        if (c.open) b.event({ type: 'panel-focus' });
        return;
      case 'ui.overlay':
        return b.setOverlay(c.overlay);
      case 'ui.split':
        return b.setSplit(c.tabIds, c.sizes, c.ratio);
      case 'split.insert':
        return b.splitInsert(c.tabId, c.index);
      case 'split.replace':
        return b.splitReplace(c.index, c.tabId);
      case 'split.remove':
        return b.splitRemove(c.tabId);
      case 'ui.dragLift':
        return b.dragLift(c.on);
      case 'ui.find':
        return b.find(c);
      case 'ui.zoom':
        return b.zoom(c.delta, c.tabId);
      case 'ui.devtools':
        return b.wcOf(c.tabId)?.openDevTools({ mode: 'detach' });
      case 'ui.copyUrl':
        return b.copyUrl(c.tabId);
      case 'ui.focusPage':
        return b.wcOf()?.focus();
      case 'banner.respond':
        return b.respondBanner(c.bannerId, c.value);
      case 'download.open': {
        const d = b.uiState().downloads.find((x) => x.id === c.id);
        if (d) (await import('electron')).shell.openPath(d.path);
        return;
      }
      case 'download.reveal': {
        const d = b.uiState().downloads.find((x) => x.id === c.id);
        if (d) (await import('electron')).shell.showItemInFolder(d.path);
        return;
      }
      case 'download.clear':
        (b as any).downloads = [];
        return b.pushState();
      case 'app.openExternal':
        return b.openExternal(c.url);
      // AI
      case 'agent.send':
        if (!b.state.panel.open) {
          b.state.panel.open = true;
          b.layout();
          b.pushState();
        }
        return b.ai.agent.send(c.text, c.tabId ?? b.activeTabId() ?? undefined);
      case 'agent.stop':
        b.ai.agent.stop();
        return b.abortAll();
      case 'agent.reset':
        return b.ai.agent.reset();
      case 'agent.pause':
        return b.setPaused(c.paused);
      case 'ask.start':
        return b.startAsk(c.query, c.tabId);
      case 'ask.followup':
        return b.ai.ask.followup(c.askId, c.query);
      case 'ask.stop':
        return b.ai.ask.stop(c.askId);
      case 'organize.start': {
        const spaceId = c.spaceId ?? b.state.activeSpaceId;
        b.setOverlay({ kind: 'organize', spaceId, loading: true, proposal: null });
        try {
          const proposal = await b.ai.organize(spaceId);
          const cur = b.uiState().overlay;
          if (cur?.kind === 'organize') b.setOverlay({ kind: 'organize', spaceId, loading: false, proposal });
        } catch (err) {
          const cur = b.uiState().overlay;
          if (cur?.kind === 'organize') b.setOverlay({ kind: 'organize', spaceId, loading: false, proposal: null, error: (err as Error).message });
        }
        return;
      }
      case 'organize.apply': {
        const p = c.proposal;
        for (const id of p.close) b.closeTab(id);
        for (const r of p.renames) b.updateTab(r.tabId, { title: r.title });
        for (const g of p.groups) {
          const ids = g.tabIds.filter((id) => b.getTab(id));
          if (ids.length >= 2) b.createFolder({ spaceId: p.spaceId, name: `${g.emoji ? g.emoji + ' ' : ''}${g.name}`, pinned: false, tabIds: ids });
        }
        b.setOverlay(null);
        b.event({ type: 'toast', text: `Organized into ${p.groups.length} groups`, tone: 'success' });
        return;
      }
      // settings
      case 'settings.update': {
        const before = b.state.settings;
        b.state.settings = deepMerge<Settings>(before, c.patch);
        nativeTheme.themeSource = b.state.settings.appearance.theme;
        b.save();
        b.pushState();
        const ctlA = before.control;
        const ctlB = b.state.settings.control;
        if (ctlA.enabled !== ctlB.enabled || ctlA.port !== ctlB.port) await app.restartControl();
        if (ctlA.cdpPort !== ctlB.cdpPort) b.event({ type: 'toast', text: 'Restart Clickless to apply the DevTools port change.' });
        return;
      }
      case 'provider.upsert': {
        const id = c.provider.id || `p${Date.now().toString(36)}`;
        if (c.apiKey !== undefined) b.secrets.set(`provider.${id}`, c.apiKey);
        const cfg: ProviderConfig = { ...(c.provider as ProviderConfig), id, hasKey: b.secrets.has(`provider.${id}`) };
        const list = b.state.settings.providers.filter((p) => p.id !== id);
        const idx = b.state.settings.providers.findIndex((p) => p.id === id);
        if (idx >= 0) list.splice(idx, 0, cfg);
        else list.push(cfg);
        b.state.settings = { ...b.state.settings, providers: list };
        if (!b.state.settings.agentProviderId) b.state.settings.agentProviderId = id;
        b.save();
        b.pushState();
        return id;
      }
      case 'provider.remove': {
        b.secrets.set(`provider.${c.providerId}`, null);
        const s = b.state.settings;
        b.state.settings = {
          ...s,
          providers: s.providers.filter((p) => p.id !== c.providerId),
          agentProviderId: s.agentProviderId === c.providerId ? null : s.agentProviderId,
          askProviderId: s.askProviderId === c.providerId ? null : s.askProviderId,
        };
        b.save();
        return b.pushState();
      }
      case 'control.regenerateToken':
        return app.regenerateToken();
      case 'import.run':
        return b.importFrom(String(c.source ?? '').toLowerCase());
      case 'agents.share':
        return b.agentProfiles?.resolveShare(c.requestId, c.tabIds);
      case 'agents.access':
        return b.agentProfiles?.setAccess(c.clientId, c.access);
      case 'agents.defaultAccess':
        b.state.settings = { ...b.state.settings, agents: { ...b.state.settings.agents, defaultAccess: c.access } };
        b.save();
        return b.pushState();
      case 'agents.show':
        return b.agentProfiles?.show(c.clientId);
      case 'agents.reset':
        return b.agentProfiles?.reset(c.clientId);
      case 'backup.configure':
        return b.backups!.configure(c);
      case 'backup.chooseFolder':
        return b.backups!.chooseFolder();
      case 'backup.run':
        return b.backups!.run();
      case 'backup.restore':
        return b.backups!.restore(c);
    }
  }

  async function runQuery<K extends QueryName>(name: K, args: QueryMap[K]['args']): Promise<QueryMap[K]['result']> {
    const a = args as any;
    switch (name) {
      case 'suggest':
        return (await suggest(a.input ?? '', a.limit)) as any;
      case 'archived': {
        const q = String(a.query ?? '').toLowerCase();
        return b.state.archived.filter((x) => !q || x.title.toLowerCase().includes(q) || x.url.toLowerCase().includes(q)).slice(0, a.limit ?? 50) as any;
      }
      case 'history':
        return b.history.search(a.query ?? '', Math.min(5000, a.limit ?? 20)) as any;
      case 'providerTest':
        return (await b.ai.testProvider(a.providerId)) as any;
      case 'providerModels':
        return (await b.ai.listModels(a.providerId).catch(() => [])) as any;
      case 'controlSecrets':
        return app.controlSecrets() as any;
      case 'askState':
        return b.ai.ask.state(a.askId) as any;
      case 'chatState':
        return b.ai.agent.state() as any;
      case 'state':
        return b.uiState() as any;
      case 'importSources':
        return listSources() as any;
      case 'recentlyClosed':
        return b.recentlyClosed() as any;
    }
    throw new Error(`unknown query ${String(name)}`);
  }

  const surfaceOf = (e: IpcMainInvokeEvent) => {
    const s = b.isUiSender(e.sender);
    if (s === 'internal') {
      const url = e.senderFrame?.url ?? '';
      if (!url.startsWith('clickless:') || e.senderFrame !== e.sender.mainFrame) return null;
    }
    return s;
  };

  ipcMain.handle(IPC.cmd, async (e, c: Command) => {
    const s = surfaceOf(e);
    if (!s) throw new Error('not allowed');
    if (s === 'internal' && !INTERNAL_PAGE_COMMANDS.includes(c.type)) throw new Error(`internal pages cannot send ${c.type}`);
    if (s === 'internal' && c.type === 'ui.overlay' && c.overlay && c.overlay.kind === 'settings') throw new Error('not allowed');
    return runCommand(c);
  });

  ipcMain.handle(IPC.query, async (e, name: QueryName, args: any) => {
    const s = surfaceOf(e);
    if (!s) throw new Error('not allowed');
    if (s === 'internal' && !INTERNAL_PAGE_QUERIES.includes(name)) throw new Error(`internal pages cannot query ${name}`);
    return runQuery(name, args ?? {});
  });

  return { runCommand, runQuery };
}
