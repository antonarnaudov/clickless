// The browser core: one window, spaces, tabs as native views, layout, persistence, and the
// `Browser` interface the tools, the control API and the AI layer use.

import {
  BaseWindow,
  Menu,
  WebContentsView,
  app,
  clipboard,
  nativeTheme,
  session,
  shell as electronShell,
  type Session,
  type WebContents,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { IPC, type ShellEvent } from '../shared/ipc';
import { APP_SCHEME, SEARCH_ENGINES, SPACE_COLORS } from '../shared/settings';
import { normalizeSteps, type Step } from '../shared/steps';
import type {
  AgentActivity,
  AskState,
  Banner,
  ChatState,
  ControlInfo,
  Download,
  FindState,
  Folder,
  OverlayState,
  Rect,
  Settings,
  Space,
  Tab,
  TabId,
  UIState,
} from '../shared/types';
import type { ActOptions, Browser, HeadlessPage, ObserveOptions, ReadOptions, ScreenshotOptions, ToolResult, AI } from './contracts';
import { runAct, type ActHost } from './act';
import { PageController } from './page';
import type { BackupService } from './backup-service';
import { countPlan, readSource, type ImportNode, type ImportPlan, type ImportReport } from './importers';
import { Headless } from './headless';
import { History, Secrets, flushState, saveStateSoon, type PersistedState, type PersistedTab } from './store';

export const PARTITION = 'persist:clickless';
const NEWTAB = `${APP_SCHEME}://newtab`;

const distDir = () => path.join(app.getAppPath(), 'dist');
export const preloadPath = (name: 'shell' | 'content') => path.join(distDir(), 'preload', `${name}.js`);

function rendererURL(page: 'shell' | 'overlay' | 'internal'): string {
  const dev = process.env.CLICKLESS_DEV_URL;
  if (dev) return `${dev.replace(/\/$/, '')}/${page}.html`;
  return 'file://' + path.join(distDir(), 'renderer', `${page}.html`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let idSeq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

interface Live {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  error?: string;
}

export class Clickless implements Browser {
  win!: BaseWindow;
  shell!: WebContentsView;
  overlay!: WebContentsView;
  ses!: Session;
  ai!: AI;
  headlessPages!: Headless;
  readonly history = new History();
  /** Encrypted backups (set in index.ts). */
  backups?: BackupService;
  readonly secrets = new Secrets();

  private tabs = new Map<TabId, Tab>();
  private views = new Map<TabId, WebContentsView>();
  private controllers = new Map<TabId, PageController>();
  private live = new Map<TabId, Live>();
  private viewports: Rect[] = [];
  private overlayState: OverlayState | null = null;
  private overlayAttached = false;
  private findState: FindState | null = null;
  private banners: Banner[] = [];
  private bannerWaiters = new Map<string, (value: string) => void>();
  private downloads: Download[] = [];
  private closed: PersistedTab[] = [];
  private openedLog: { opener: TabId; tab: TabId; at: number }[] = [];
  private openerOf = new Map<TabId, TabId>();
  private fullscreen = false;
  private htmlFullscreen: TabId | null = null;
  private activityCount = 0;
  private activityEnd: ReturnType<typeof setTimeout> | null = null;
  private activityFields: Omit<AgentActivity, 'clients'> = { active: false, source: null, tabId: null, label: null, paused: false };
  private clients = new Map<string, { name: string; lastSeenAt: number; calls: number }>();
  private aborters = new Set<AbortController>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  control: ControlInfo;

  constructor(
    public state: PersistedState,
    discoveryFile: string,
  ) {
    this.control = { running: false, port: null, url: null, mcpUrl: null, cdpPort: state.settings.control.cdpPort, discoveryFile };
    for (const t of state.tabs) {
      this.tabs.set(t.id, {
        ...t,
        favorite: !!t.favorite,
        pinned: !!t.pinned,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        audible: false,
        muted: !!t.muted,
        asleep: true,
        zoom: t.zoom ?? 0,
        internal: t.url.startsWith(`${APP_SCHEME}:`),
      });
    }
  }

  // =====================================================================
  // window & views
  // =====================================================================

  createWindow() {
    this.ses = session.fromPartition(PARTITION);
    const ua = this.ses.getUserAgent().replace(/\s(Electron|clickless|Clickless)\/\S+/g, '');
    this.ses.setUserAgent(ua);
    this.headlessPages = new Headless(this.ses, preloadPath('content'));

    const b = (this.state as any).bounds as Rect | undefined;
    this.win = new BaseWindow({
      width: b?.width ?? 1440,
      height: b?.height ?? 900,
      x: b?.x,
      y: b?.y,
      minWidth: 640,
      minHeight: 420,
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: 18 },
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#17151f' : '#efeaf9',
      title: 'Clickless',
    });

    this.shell = new WebContentsView({
      webPreferences: { preload: preloadPath('shell'), sandbox: true, contextIsolation: true, additionalArguments: ['--clickless-surface=shell'], spellcheck: false },
    });
    this.shell.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.shell);
    this.shell.webContents.loadURL(rendererURL('shell'));

    this.overlay = new WebContentsView({
      webPreferences: { preload: preloadPath('shell'), sandbox: true, contextIsolation: true, additionalArguments: ['--clickless-surface=overlay'], spellcheck: false },
    });
    this.overlay.setBackgroundColor('#00000000');
    this.overlay.webContents.loadURL(rendererURL('overlay'));

    for (const wc of [this.shell.webContents, this.overlay.webContents]) {
      wc.on('did-finish-load', () => this.pushNow());
      wc.setWindowOpenHandler(({ url }) => {
        this.openTab(url).catch(() => {});
        return { action: 'deny' };
      });
      wc.on('will-navigate', (e) => e.preventDefault());
      if (process.env.CLICKLESS_DEV_URL || !app.isPackaged) {
        wc.on('before-input-event', (_e, input) => {
          if (input.type === 'keyDown' && input.meta && input.alt && input.shift && input.key.toLowerCase() === 'i') wc.openDevTools({ mode: 'detach' });
        });
      }
    }

    const resize = () => {
      const { width, height } = this.win.getContentBounds();
      this.shell.setBounds({ x: 0, y: 0, width, height });
      this.overlay.setBounds({ x: 0, y: 0, width, height });
      this.layout();
      const nb = this.win.getBounds();
      (this.state as any).bounds = nb;
      this.save();
    };
    this.win.on('resize', resize);
    this.win.on('move', () => {
      (this.state as any).bounds = this.win.getBounds();
      this.save();
    });
    this.win.on('enter-full-screen', () => {
      this.fullscreen = true;
      this.pushState();
    });
    this.win.on('leave-full-screen', () => {
      this.fullscreen = false;
      this.pushState();
    });
    this.win.on('closed', () => {
      flushState();
      this.history.flush();
      app.quit();
    });
    nativeTheme.on('updated', () => this.pushState());
    resize();

    this.setupSession();

    // restore: wake the active tab of the active space
    const active = this.activeTabId();
    if (active) this.activateTab(active);
    else if (!this.spaceTabs(this.state.activeSpaceId).length) this.openTab(NEWTAB).catch(() => {});

    setInterval(() => this.housekeeping(), 60_000);
  }

  private setupSession() {
    const ses = this.ses;
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const auto = ['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock', 'window-management', 'speaker-selection'];
      if (auto.includes(permission)) return callback(true);
      let origin = '';
      try {
        origin = new URL((details as any).requestingUrl || wc.getURL()).origin;
      } catch {
        return callback(false);
      }
      if (origin.startsWith(`${APP_SCHEME}:`)) return callback(true);
      const remembered = this.state.sitePermissions[origin]?.[permission];
      if (remembered) return callback(remembered === 'allow');
      const tabId = this.tabIdOf(wc);
      const host = origin.replace(/^https?:\/\//, '');
      const label: Record<string, string> = {
        media: 'use your camera or microphone',
        geolocation: 'know your location',
        notifications: 'show notifications',
        'clipboard-read': 'read your clipboard',
        midi: 'use MIDI devices',
        midiSysex: 'use MIDI devices',
        'display-capture': 'share your screen',
        'idle-detection': 'know when you are idle',
        hid: 'use HID devices',
        serial: 'use serial ports',
        usb: 'use USB devices',
        'storage-access': 'use cookies across sites',
        'top-level-storage-access': 'use cookies across sites',
      };
      this.ask({
        kind: 'permission',
        tabId: tabId ?? undefined,
        title: `${host} wants to ${label[permission] ?? permission}`,
        actions: [
          { label: 'Allow', value: 'allow' },
          { label: 'Block', value: 'deny' },
        ],
      }).then((v) => {
        const allow = v === 'allow';
        if (v === 'allow' || v === 'deny') {
          this.state.sitePermissions[origin] = { ...(this.state.sitePermissions[origin] ?? {}), [permission]: allow ? 'allow' : 'deny' };
          this.save();
        }
        callback(allow);
      });
    });
    ses.setPermissionCheckHandler((_wc, permission, origin) => {
      if (['clipboard-sanitized-write', 'fullscreen', 'pointerLock'].includes(permission)) return true;
      if (origin?.startsWith(`${APP_SCHEME}:`)) return true;
      return this.state.sitePermissions[origin ?? '']?.[permission] === 'allow';
    });

    ses.on('will-download', (_e, item) => {
      const dir = app.getPath('downloads');
      let name = item.getFilename() || 'download';
      let target = path.join(dir, name);
      for (let i = 1; fs.existsSync(target) && i < 500; i++) {
        const ext = path.extname(name);
        target = path.join(dir, `${path.basename(name, ext)} (${i})${ext}`);
      }
      item.setSavePath(target);
      const d: Download = {
        id: uid('d'),
        filename: path.basename(target),
        path: target,
        url: item.getURL(),
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        state: 'progressing',
        startedAt: Date.now(),
      };
      this.downloads.unshift(d);
      this.downloads = this.downloads.slice(0, 20);
      item.on('updated', (_ev, st) => {
        d.receivedBytes = item.getReceivedBytes();
        d.totalBytes = item.getTotalBytes();
        d.state = st === 'interrupted' ? 'interrupted' : 'progressing';
        this.pushState();
      });
      item.once('done', (_ev, st) => {
        d.state = st === 'completed' ? 'completed' : st === 'cancelled' ? 'cancelled' : 'interrupted';
        d.receivedBytes = item.getReceivedBytes();
        if (d.state === 'completed') this.event({ type: 'toast', text: `Downloaded ${d.filename}`, tone: 'success' });
        this.pushState();
      });
      this.pushState();
    });
  }

  private createView(tab: Tab, adopt?: Electron.BrowserWindowConstructorOptions): WebContentsView {
    const view = adopt
      ? new WebContentsView(adopt as any)
      : new WebContentsView({
          webPreferences: {
            preload: preloadPath('content'),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: true,
            partition: PARTITION,
            scrollBounce: true,
            spellcheck: true,
          },
        });
    view.setBorderRadius(10);
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1b1a22' : '#ffffff');
    const wc = view.webContents;
    this.views.set(tab.id, view);
    this.live.set(tab.id, { loading: false, canGoBack: false, canGoForward: false, audible: false });
    const ctl = new PageController(wc, { settings: () => this.state.settings, isVisible: () => this.isVisible(tab.id) });
    this.controllers.set(tab.id, ctl);
    this.wireTab(tab.id, wc);
    if (tab.muted) wc.setAudioMuted(true);
    if (tab.zoom) wc.setZoomLevel(tab.zoom);
    tab.asleep = false;
    return view;
  }

  private wireTab(id: TabId, wc: WebContents) {
    const tab = () => this.tabs.get(id);
    const live = () => this.live.get(id)!;
    const nav = () => {
      const l = this.live.get(id);
      if (!l || wc.isDestroyed()) return;
      l.canGoBack = wc.navigationHistory.canGoBack();
      l.canGoForward = wc.navigationHistory.canGoForward();
    };
    wc.on('did-start-loading', () => {
      live().loading = true;
      live().error = undefined;
      this.pushState();
    });
    wc.on('did-stop-loading', () => {
      live().loading = false;
      nav();
      this.pushState();
    });
    wc.on('page-title-updated', (_e, title) => {
      const t = tab();
      if (!t) return;
      t.title = title;
      this.history.update(wc.getURL(), { title });
      this.save();
      this.pushState();
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      const t = tab();
      if (!t || !icons.length) return;
      t.favicon = icons[0];
      this.history.update(wc.getURL(), { favicon: icons[0] });
      this.save();
      this.pushState();
    });
    const onNav = (url: string, inPage: boolean) => {
      const t = tab();
      if (!t) return;
      t.url = url;
      t.internal = url.startsWith(`${APP_SCHEME}:`);
      if (!inPage || !t.title) t.title = t.internal ? this.internalTitle(url) : wc.getTitle() || url;
      nav();
      if (!t.internal) this.history.add(url, wc.getTitle(), t.favicon);
      this.save();
      this.pushState();
    };
    wc.on('did-navigate', (_e, url) => onNav(url, false));
    wc.on('did-navigate-in-page', (_e, url, isMain) => isMain && onNav(url, true));
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return;
      live().error = desc;
      const t = tab();
      if (t && !url.startsWith(`${APP_SCHEME}:`)) {
        const errUrl = `${APP_SCHEME}://error/?code=${code}&desc=${encodeURIComponent(desc)}&url=${encodeURIComponent(url)}`;
        wc.loadURL(errUrl).catch(() => {});
      }
      this.pushState();
    });
    wc.on('audio-state-changed', (e) => {
      live().audible = (e as any).audible ?? wc.isCurrentlyAudible();
      this.pushState();
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      live().error = `The page crashed (${details.reason}).`;
      this.pushState();
    });
    wc.on('found-in-page', (_e, r) => {
      if (!this.findState) return;
      this.findState = { ...this.findState, activeMatch: r.activeMatchOrdinal, matches: r.matches };
      this.pushState();
    });
    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreen = id;
      this.layout();
    });
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreen = null;
      this.layout();
    });
    wc.on('context-menu', (_e, params) => this.pageContextMenu(id, wc, params));
    wc.setWindowOpenHandler((details) => {
      const background = details.disposition === 'background-tab';
      return {
        action: 'allow',
        outlivesOpener: true,
        createWindow: (options) => {
          const t = this.newTabRecord(details.url, { spaceId: tab()?.spaceId, openerTabId: id });
          const view = this.createView(t, options);
          this.openedLog.push({ opener: id, tab: t.id, at: Date.now() });
          this.openedLog = this.openedLog.slice(-20);
          this.openerOf.set(t.id, id);
          if (!background) this.activateTab(t.id);
          else this.pushState();
          return view.webContents;
        },
      };
    });
    wc.on('destroyed', () => {
      const t = this.tabs.get(id);
      if (t && this.views.get(id)?.webContents === wc) {
        // closed by the page (window.close) or crashed away
        if (!t.asleep) this.closeTab(id);
      }
    });
    wc.on('did-finish-load', () => {
      if (wc.getURL().startsWith(`${APP_SCHEME}:`)) this.pushNow();
    });
  }

  private internalTitle(url: string): string {
    if (url.startsWith(`${APP_SCHEME}://ask`)) return 'Ask';
    if (url.startsWith(`${APP_SCHEME}://error`)) return 'Page not available';
    return 'New Tab';
  }

  private pageContextMenu(id: TabId, wc: WebContents, p: Electron.ContextMenuParams) {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (p.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.openTab(p.linkURL, { background: false }) },
        { label: 'Open Link in Background', click: () => this.openTab(p.linkURL, { background: true }) },
        { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => this.openTab(p.srcURL) },
        { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(p.srcURL) },
        { label: 'Save Image…', click: () => wc.downloadURL(p.srcURL) },
        { type: 'separator' },
      );
    }
    if (p.selectionText) {
      const sel = p.selectionText.trim();
      const short = sel.length > 30 ? sel.slice(0, 29) + '…' : sel;
      items.push(
        { label: 'Copy', role: 'copy' },
        { label: `Ask AI about “${short}”`, click: () => this.startAsk(sel) },
        { label: `Search for “${short}”`, click: () => this.openTab(this.searchUrl(sel)) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
      for (const s of p.dictionarySuggestions.slice(0, 4)) items.unshift({ label: s, click: () => wc.replaceMisspelling(s) });
    }
    if (!p.linkURL && !p.selectionText && !p.isEditable) {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Ask AI about this page', click: () => this.openPanelWith('Summarize this page') },
        { label: 'Copy Page URL', click: () => clipboard.writeText(wc.getURL()) },
        { type: 'separator' },
      );
    }
    items.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup();
    void id;
  }

  openPanelWith(text: string) {
    this.state.panel.open = true;
    this.layout();
    this.pushState();
    this.ai?.agent.send(text, this.activeTabId() ?? undefined);
  }

  isVisible(id: TabId): boolean {
    const visible = this.visibleTabIds();
    return visible.includes(id) && !this.win.isMinimized();
  }

  private visibleTabIds(): TabId[] {
    const active = this.activeTabId();
    if (!active) return [];
    if (this.htmlFullscreen) return [this.htmlFullscreen];
    const split = (this.state as any).split as { tabIds: [TabId, TabId]; ratio: number } | null;
    if (split && split.tabIds.includes(active) && split.tabIds.every((t) => this.tabs.has(t))) return split.tabIds;
    return [active];
  }

  /** Puts the visible tab views where the shell said, and stacks the overlay on top. */
  layout() {
    if (!this.win || this.win.isDestroyed()) return;
    const visible = this.visibleTabIds();
    const { width, height } = this.win.getContentBounds();
    const fallback: Rect = {
      x: this.state.sidebar.visible ? this.state.sidebar.width + 8 : 8,
      y: 8,
      width: width - (this.state.sidebar.visible ? this.state.sidebar.width + 16 : 16) - (this.state.panel.open ? this.state.panel.width : 0),
      height: height - 16,
    };
    for (const [id, view] of this.views) {
      if (!visible.includes(id)) {
        if ((view as any).__attached) {
          this.win.contentView.removeChildView(view);
          (view as any).__attached = false;
        }
      }
    }
    visible.forEach((id, i) => {
      const view = this.views.get(id);
      if (!view) return;
      let r = this.htmlFullscreen ? { x: 0, y: 0, width, height } : (this.viewports[i] ?? (i === 0 ? fallback : null));
      if (!r) return;
      r = { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
      view.setBounds(r);
      view.setBorderRadius(this.htmlFullscreen ? 0 : 10);
      if (!(view as any).__attached) {
        this.win.contentView.addChildView(view);
        (view as any).__attached = true;
      }
    });
    if (this.overlayState) {
      this.win.contentView.addChildView(this.overlay); // (re)adding moves it to the top
      this.overlayAttached = true;
    } else if (this.overlayAttached) {
      this.win.contentView.removeChildView(this.overlay);
      this.overlayAttached = false;
    }
  }

  // =====================================================================
  // state
  // =====================================================================

  settings(): Settings {
    return this.state.settings;
  }

  save() {
    saveStateSoon(() => this.persistedState());
  }

  persistedState(): PersistedState {
    const tabs: PersistedTab[] = Array.from(this.tabs.values())
      .filter((t) => !t.url.startsWith(`${APP_SCHEME}://error`))
      .map((t) => ({
        id: t.id,
        spaceId: t.spaceId,
        url: t.url,
        title: t.title,
        favicon: t.favicon,
        favorite: t.favorite,
        pinned: t.pinned,
        folderId: t.folderId,
        order: t.order,
        createdAt: t.createdAt,
        lastActiveAt: t.lastActiveAt,
        zoom: t.zoom,
        muted: t.muted,
      }));
    return { ...this.state, tabs };
  }

  uiState(): UIState {
    const tabs = Array.from(this.tabs.values()).map((t) => {
      const l = this.live.get(t.id);
      return l ? { ...t, loading: l.loading, canGoBack: l.canGoBack, canGoForward: l.canGoForward, audible: l.audible, error: l.error } : { ...t };
    });
    const split = (this.state as any).split ?? null;
    return {
      spaces: this.state.spaces,
      activeSpaceId: this.state.activeSpaceId,
      tabs,
      folders: this.state.folders,
      activeTabId: this.activeTabId(),
      split: split && split.tabIds.every((t: TabId) => this.tabs.has(t)) ? split : null,
      sidebar: this.state.sidebar,
      panel: this.state.panel,
      overlay: this.overlayState,
      find: this.findState,
      banners: this.banners,
      downloads: this.downloads,
      agent: { ...this.activityFields, clients: Array.from(this.clients.values()).filter((c) => Date.now() - c.lastSeenAt < 30 * 60_000) },
      settings: this.state.settings,
      control: this.control,
      platform: process.platform as UIState['platform'],
      fullscreen: this.fullscreen,
      backup: this.backups?.status() ?? { hasPassphrase: false, hasGithubToken: false, running: false },
    };
  }

  /** Coalesces state pushes to one per frame. */
  pushState() {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => this.pushNow(), 16);
  }

  pushNow() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    const s = this.uiState();
    for (const wc of this.uiContents()) wc.send(IPC.state, s);
  }

  private uiContents(): WebContents[] {
    const list: WebContents[] = [];
    if (this.shell && !this.shell.webContents.isDestroyed()) list.push(this.shell.webContents);
    if (this.overlay && !this.overlay.webContents.isDestroyed()) list.push(this.overlay.webContents);
    for (const [id, v] of this.views) {
      const t = this.tabs.get(id);
      if (t?.internal && !v.webContents.isDestroyed()) list.push(v.webContents);
    }
    return list;
  }

  emitChat(chat: ChatState) {
    if (this.shell && !this.shell.webContents.isDestroyed()) this.shell.webContents.send(IPC.chat, chat);
  }

  emitAsk(ask: AskState) {
    for (const [id, v] of this.views) {
      const t = this.tabs.get(id);
      if (t?.url.startsWith(`${APP_SCHEME}://ask`) && !v.webContents.isDestroyed()) v.webContents.send(IPC.ask, ask);
    }
  }

  event(e: ShellEvent) {
    if (this.shell && !this.shell.webContents.isDestroyed()) this.shell.webContents.send(IPC.event, e);
    if (this.overlay && !this.overlay.webContents.isDestroyed()) this.overlay.webContents.send(IPC.event, e);
  }

  isUiSender(wc: WebContents): 'shell' | 'overlay' | 'internal' | null {
    if (wc === this.shell?.webContents) return 'shell';
    if (wc === this.overlay?.webContents) return 'overlay';
    const id = this.tabIdOf(wc);
    if (id && this.tabs.get(id)?.internal) return 'internal';
    return null;
  }

  tabIdOf(wc: WebContents): TabId | null {
    for (const [id, v] of this.views) if (v.webContents === wc) return id;
    return null;
  }

  // =====================================================================
  // spaces, sections, ordering
  // =====================================================================

  spaceTabs(spaceId: string): Tab[] {
    return Array.from(this.tabs.values()).filter((t) => t.spaceId === spaceId && !t.favorite);
  }

  /** Sidebar order: favorites, then pinned (folders expanded), then today. */
  sidebarOrder(spaceId = this.state.activeSpaceId): Tab[] {
    const favs = Array.from(this.tabs.values())
      .filter((t) => t.favorite)
      .sort((a, b) => a.order - b.order);
    const section = (pinned: boolean) => {
      const tabs = this.spaceTabs(spaceId).filter((t) => t.pinned === pinned);
      const folders = this.state.folders.filter((f) => f.spaceId === spaceId && f.pinned === pinned);
      const items: { order: number; tabs: Tab[] }[] = [
        ...tabs.filter((t) => !t.folderId || !folders.some((f) => f.id === t.folderId)).map((t) => ({ order: t.order, tabs: [t] })),
        ...folders.map((f) => ({
          order: f.order,
          tabs: f.collapsed ? [] : tabs.filter((t) => t.folderId === f.id).sort((a, b) => a.order - b.order),
        })),
      ];
      return items.sort((a, b) => a.order - b.order).flatMap((i) => i.tabs);
    };
    return [...favs, ...section(true), ...section(false)];
  }

  activeTabId(): TabId | null {
    const id = this.state.activeTabBySpace[this.state.activeSpaceId];
    if (id && this.tabs.has(id)) return id;
    return null;
  }

  private minOrder(spaceId: string, pinned: boolean, folderId?: string): number {
    let min = 0;
    for (const t of this.tabs.values()) if (t.spaceId === spaceId && t.pinned === pinned && !t.favorite && (t.folderId ?? undefined) === folderId) min = Math.min(min, t.order);
    for (const f of this.state.folders) if (!folderId && f.spaceId === spaceId && f.pinned === pinned) min = Math.min(min, f.order);
    return min;
  }

  private maxOrder(filter: (t: Tab) => boolean, folders: Folder[] = []): number {
    let max = 0;
    for (const t of this.tabs.values()) if (filter(t)) max = Math.max(max, t.order);
    for (const f of folders) max = Math.max(max, f.order);
    return max;
  }

  private newTabRecord(url: string, opts: { spaceId?: string; pinned?: boolean; folderId?: string; openerTabId?: TabId } = {}): Tab {
    const spaceId = opts.spaceId && this.state.spaces.some((s) => s.id === opts.spaceId) ? opts.spaceId : this.state.activeSpaceId;
    const pinned = !!opts.pinned;
    let order = this.minOrder(spaceId, pinned, opts.folderId) - 1;
    if (opts.openerTabId) {
      // Arc-style: new tabs at the top of Today; tabs opened by a page sit right below their opener
      const opener = this.tabs.get(opts.openerTabId);
      if (opener && !opener.pinned && !opener.favorite && opener.spaceId === spaceId) order = opener.order + 0.001 + Math.random() * 0.0001;
    }
    const id = `t${this.state.nextTab++}`;
    const t: Tab = {
      id,
      spaceId,
      url,
      title: url.startsWith(`${APP_SCHEME}:`) ? this.internalTitle(url) : url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80),
      favorite: false,
      pinned,
      folderId: opts.folderId,
      order,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      audible: false,
      muted: false,
      asleep: true,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      zoom: 0,
      internal: url.startsWith(`${APP_SCHEME}:`),
    };
    this.tabs.set(id, t);
    this.save();
    return t;
  }

  /** Renumbers a container so `id` lands before `beforeId` (or at the end). */
  private place(items: { id: string; order: number; set: (o: number) => void }[], id: string, beforeId?: string | null) {
    const moving = items.find((i) => i.id === id);
    const rest = items.filter((i) => i.id !== id).sort((a, b) => a.order - b.order);
    let idx = beforeId ? rest.findIndex((i) => i.id === beforeId) : -1;
    if (idx < 0) idx = rest.length;
    if (moving) rest.splice(idx, 0, moving);
    rest.forEach((it, i) => it.set(i));
  }

  private containerItems(spaceId: string, pinned: boolean, folderId: string | undefined, favorite: boolean) {
    if (favorite) {
      return Array.from(this.tabs.values())
        .filter((t) => t.favorite)
        .map((t) => ({ id: t.id, order: t.order, set: (o: number) => (t.order = o) }));
    }
    const tabs = Array.from(this.tabs.values())
      .filter((t) => !t.favorite && t.spaceId === spaceId && t.pinned === pinned && (folderId ? t.folderId === folderId : !t.folderId))
      .map((t) => ({ id: t.id, order: t.order, set: (o: number) => (t.order = o) }));
    if (folderId) return tabs;
    const folders = this.state.folders
      .filter((f) => f.spaceId === spaceId && f.pinned === pinned)
      .map((f) => ({ id: f.id, order: f.order, set: (o: number) => (f.order = o) }));
    return [...tabs, ...folders];
  }

  moveTab(tabId: TabId, to: { spaceId?: string; pinned?: boolean; favorite?: boolean; folderId?: string | null; beforeId?: string | null }) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    if (to.favorite !== undefined) t.favorite = to.favorite;
    if (to.spaceId && this.state.spaces.some((s) => s.id === to.spaceId)) t.spaceId = to.spaceId;
    if (to.folderId !== undefined) {
      const f = to.folderId ? this.state.folders.find((x) => x.id === to.folderId) : undefined;
      t.folderId = f?.id;
      if (f) {
        t.pinned = f.pinned;
        t.spaceId = f.spaceId;
      }
    }
    if (to.pinned !== undefined && !t.folderId) t.pinned = to.pinned;
    if (t.favorite) {
      t.pinned = false;
      t.folderId = undefined;
    }
    this.place(this.containerItems(t.spaceId, t.pinned, t.folderId, t.favorite), tabId, to.beforeId);
    if (t.spaceId !== this.state.activeSpaceId && this.activeTabId() === tabId && !t.favorite) {
      delete this.state.activeTabBySpace[this.state.activeSpaceId];
      this.state.activeTabBySpace[t.spaceId] = t.id;
      this.pickNextActive();
    }
    this.save();
    this.pushState();
  }

  moveFolder(folderId: string, to: { pinned?: boolean; beforeId?: string | null }) {
    const f = this.state.folders.find((x) => x.id === folderId);
    if (!f) return;
    if (to.pinned !== undefined && to.pinned !== f.pinned) {
      f.pinned = to.pinned;
      for (const t of this.tabs.values()) if (t.folderId === f.id) t.pinned = f.pinned;
    }
    this.place(this.containerItems(f.spaceId, f.pinned, undefined, false), folderId, to.beforeId);
    this.save();
    this.pushState();
  }

  createFolder(opts: { spaceId?: string; name?: string; pinned?: boolean; tabIds?: TabId[] }): string {
    const spaceId = opts.spaceId ?? this.state.activeSpaceId;
    const pinned = opts.pinned ?? true;
    const f: Folder = { id: uid('f'), spaceId, name: opts.name || 'New Folder', collapsed: false, pinned, order: this.minOrder(spaceId, pinned) - 1 };
    this.state.folders.push(f);
    for (const id of opts.tabIds ?? []) {
      const t = this.tabs.get(id);
      if (!t) continue;
      t.folderId = f.id;
      t.pinned = pinned;
      t.spaceId = spaceId;
      t.favorite = false;
    }
    this.save();
    this.pushState();
    return f.id;
  }

  deleteFolder(folderId: string, closeTabs = false) {
    const f = this.state.folders.find((x) => x.id === folderId);
    if (!f) return;
    for (const t of Array.from(this.tabs.values())) {
      if (t.folderId !== folderId) continue;
      if (closeTabs) this.closeTab(t.id);
      else {
        t.folderId = undefined;
        t.order = f.order + t.order / 1000;
      }
    }
    this.state.folders = this.state.folders.filter((x) => x.id !== folderId);
    this.save();
    this.pushState();
  }

  createSpace(p: { name?: string; icon?: string; color?: string }): string {
    const colors = SPACE_COLORS;
    const s: Space = { id: uid('s'), name: p.name || `Space ${this.state.spaces.length + 1}`, icon: p.icon || '✨', color: p.color || colors[this.state.spaces.length % colors.length] };
    this.state.spaces.push(s);
    this.save();
    this.activateSpace(s.id);
    return s.id;
  }

  deleteSpace(spaceId: string) {
    if (this.state.spaces.length <= 1) return;
    for (const t of Array.from(this.tabs.values())) if (t.spaceId === spaceId && !t.favorite) this.closeTab(t.id, { archive: true });
    this.state.folders = this.state.folders.filter((f) => f.spaceId !== spaceId);
    this.state.spaces = this.state.spaces.filter((s) => s.id !== spaceId);
    delete this.state.activeTabBySpace[spaceId];
    if (this.state.activeSpaceId === spaceId) this.activateSpace(this.state.spaces[0].id);
    this.save();
    this.pushState();
  }

  activateSpace(spaceId: string) {
    if (!this.state.spaces.some((s) => s.id === spaceId)) return;
    this.state.activeSpaceId = spaceId;
    (this.state as any).split = null;
    const id = this.activeTabId() ?? this.sidebarOrder(spaceId).find((t) => !t.favorite)?.id ?? null;
    if (id) this.activateTab(id);
    else {
      this.layout();
      this.pushState();
      this.setOverlay({ kind: 'palette', mode: 'new-tab' });
    }
    this.save();
  }

  // =====================================================================
  // tabs
  // =====================================================================

  listTabs(opts: { spaceId?: string; all?: boolean } = {}): Tab[] {
    const ui = this.uiState().tabs;
    if (opts.all) return ui;
    const spaceId = opts.spaceId ?? this.state.activeSpaceId;
    return ui.filter((t) => t.favorite || t.spaceId === spaceId);
  }

  activeTab(): Tab | null {
    const id = this.activeTabId();
    return id ? (this.uiState().tabs.find((t) => t.id === id) ?? null) : null;
  }

  getTab(id: TabId): Tab | null {
    return this.uiState().tabs.find((t) => t.id === id) ?? null;
  }

  toUrl(input: string): string {
    const s = input.trim();
    if (!s) return NEWTAB;
    if (/^(https?|file|clickless|about|data|view-source|chrome|blob|mailto):/i.test(s)) return s;
    if (/^localhost(:\d+)?(\/.*)?$/i.test(s) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(s) || /^\[[0-9a-f:]+\](:\d+)?/i.test(s)) return `http://${s}`;
    if (!/\s/.test(s) && /^[^/?#]+\.[a-z]{2,24}(:\d+)?([/?#].*)?$/i.test(s)) return `https://${s}`;
    return this.searchUrl(s);
  }

  searchUrl(query: string): string {
    const st = this.state.settings;
    const tpl = st.searchEngine === 'custom' && st.customSearchURL ? st.customSearchURL : SEARCH_ENGINES[st.searchEngine as keyof typeof SEARCH_ENGINES]?.url ?? SEARCH_ENGINES.google.url;
    return tpl.replace('%s', encodeURIComponent(query));
  }

  async openTab(url: string, opts: { background?: boolean; spaceId?: string; source?: string; pinned?: boolean; folderId?: string; openerTabId?: TabId } = {}): Promise<Tab> {
    const t = this.newTabRecord(this.toUrl(url), opts);
    if (opts.background) {
      this.wake(t.id);
      this.pushState();
    } else this.activateTab(t.id);
    return this.getTab(t.id)!;
  }

  /** Makes sure a tab has live web contents. */
  wake(id: TabId): WebContentsView | null {
    const t = this.tabs.get(id);
    if (!t) return null;
    let view = this.views.get(id);
    if (view && !view.webContents.isDestroyed()) return view;
    view = this.createView(t);
    view.webContents.loadURL(t.url).catch(() => {});
    return view;
  }

  activateTab(id: TabId) {
    const t = this.tabs.get(id);
    if (!t) return;
    if (!t.favorite && t.spaceId !== this.state.activeSpaceId) this.state.activeSpaceId = t.spaceId;
    const split = (this.state as any).split as { tabIds: [TabId, TabId] } | null;
    if (split && !split.tabIds.includes(id)) (this.state as any).split = null;
    this.state.activeTabBySpace[this.state.activeSpaceId] = id;
    t.lastActiveAt = Date.now();
    const view = this.wake(id);
    this.layout();
    if (!this.overlayState) view?.webContents.focus();
    if (this.findState) {
      this.findState = null;
    }
    this.save();
    this.pushState();
  }

  private pickNextActive(closingId?: TabId) {
    const order = this.sidebarOrder().filter((t) => !t.favorite);
    const idx = closingId ? order.findIndex((t) => t.id === closingId) : -1;
    const candidates = order.filter((t) => t.id !== closingId);
    const opener = closingId ? this.openerOf.get(closingId) : undefined;
    const next = (opener && this.tabs.has(opener) && opener) || candidates[Math.max(0, Math.min(idx, candidates.length - 1))]?.id;
    if (next) this.activateTab(next);
    else {
      delete this.state.activeTabBySpace[this.state.activeSpaceId];
      this.layout();
      this.pushState();
      this.setOverlay({ kind: 'palette', mode: 'new-tab' });
    }
  }

  closeTab(id: TabId, opts: { archive?: boolean } = {}) {
    const t = this.tabs.get(id);
    if (!t) return;
    const wasActive = this.activeTabId() === id;
    this.tabs.delete(id);
    const rec = this.persistedState().tabs.find((x) => x.id === id) ?? ({ ...t } as PersistedTab);
    if (!t.internal) {
      this.closed.push({ ...rec, ...t });
      this.closed = this.closed.slice(-30);
      if (opts.archive) {
        this.state.archived.unshift({ id: uid('a'), url: t.url, title: t.title, favicon: t.favicon, spaceId: t.spaceId, archivedAt: Date.now() });
        this.state.archived = this.state.archived.slice(0, 500);
      }
    }
    this.sleepTab(id);
    this.live.delete(id);
    const split = (this.state as any).split as { tabIds: TabId[] } | null;
    if (split?.tabIds.includes(id)) (this.state as any).split = null;
    for (const [space, tid] of Object.entries(this.state.activeTabBySpace)) if (tid === id && space !== this.state.activeSpaceId) delete this.state.activeTabBySpace[space];
    if (wasActive) this.pickNextActive(id);
    this.openerOf.delete(id);
    this.save();
    this.pushState();
  }

  /** Destroys a tab's web contents but keeps the tab. */
  sleepTab(id: TabId) {
    const view = this.views.get(id);
    if (view) {
      this.views.delete(id);
      this.controllers.delete(id);
      if ((view as any).__attached) this.win.contentView.removeChildView(view);
      const t = this.tabs.get(id);
      if (t) t.asleep = true;
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
  }

  reopenClosed() {
    const rec = this.closed.pop();
    if (!rec) return;
    const t = this.newTabRecord(rec.url, { spaceId: rec.spaceId, pinned: rec.pinned, folderId: rec.folderId });
    t.title = rec.title;
    t.favicon = rec.favicon;
    this.activateTab(t.id);
  }

  restoreArchived(archivedId: string) {
    const a = this.state.archived.find((x) => x.id === archivedId);
    if (!a) return;
    this.state.archived = this.state.archived.filter((x) => x.id !== archivedId);
    this.openTab(a.url, { spaceId: this.state.activeSpaceId }).catch(() => {});
  }

  clearToday(spaceId = this.state.activeSpaceId) {
    for (const t of this.spaceTabs(spaceId)) if (!t.pinned && !t.favorite) this.closeTab(t.id, { archive: true });
  }

  updateTab(id: TabId, patch: { favorite?: boolean; pinned?: boolean; title?: string; muted?: boolean }) {
    const t = this.tabs.get(id);
    if (!t) return;
    if (patch.favorite !== undefined || patch.pinned !== undefined) {
      this.moveTab(id, { favorite: patch.favorite, pinned: patch.pinned, folderId: patch.pinned === false ? null : undefined });
    }
    if (patch.title !== undefined) t.title = patch.title;
    if (patch.muted !== undefined) {
      t.muted = patch.muted;
      this.views.get(id)?.webContents.setAudioMuted(patch.muted);
    }
    this.save();
    this.pushState();
  }

  duplicateTab(id: TabId) {
    const t = this.tabs.get(id);
    if (!t) return;
    this.openTab(t.url, { spaceId: t.spaceId, openerTabId: id }).catch(() => {});
  }

  cycleTabs(dir: 1 | -1) {
    const order = this.sidebarOrder();
    if (!order.length) return;
    const idx = order.findIndex((t) => t.id === this.activeTabId());
    const next = order[(idx + dir + order.length) % order.length];
    this.activateTab(next.id);
  }

  wcOf(id?: TabId): WebContents | null {
    const tid = id ?? this.activeTabId();
    if (!tid) return null;
    return this.wake(tid)?.webContents ?? null;
  }

  setViewports(rects: Rect[]) {
    this.viewports = rects;
    this.layout();
  }

  setOverlay(o: OverlayState | null) {
    this.overlayState = o;
    this.layout();
    if (o) this.overlay.webContents.focus();
    else this.wcOf()?.focus();
    this.pushState();
  }

  setSplit(tabIds: [TabId, TabId] | null, ratio?: number) {
    if (tabIds && tabIds.every((t) => this.tabs.has(t)) && tabIds[0] !== tabIds[1]) {
      (this.state as any).split = { tabIds, ratio: ratio ?? (this.state as any).split?.ratio ?? 0.5 };
      for (const t of tabIds) this.wake(t);
      this.state.activeTabBySpace[this.state.activeSpaceId] = tabIds[0];
    } else if (!tabIds && ratio !== undefined && (this.state as any).split) {
      (this.state as any).split.ratio = ratio;
    } else (this.state as any).split = null;
    this.layout();
    this.save();
    this.pushState();
  }

  find(c: { query?: string; next?: boolean; back?: boolean; close?: boolean }) {
    const wc = this.wcOf();
    if (!wc) return;
    if (c.close) {
      wc.stopFindInPage('clearSelection');
      this.findState = null;
    } else {
      const query = c.query ?? this.findState?.query ?? '';
      this.findState = { query, activeMatch: this.findState?.activeMatch ?? 0, matches: this.findState?.matches ?? 0 };
      if (query) wc.findInPage(query, { findNext: !c.next && !c.back ? true : false, forward: !c.back });
      else {
        wc.stopFindInPage('clearSelection');
        this.findState = { query: '', activeMatch: 0, matches: 0 };
      }
    }
    this.pushState();
  }

  zoom(delta: 1 | -1 | 0, id?: TabId) {
    const wc = this.wcOf(id);
    const tid = id ?? this.activeTabId();
    if (!wc || !tid) return;
    const t = this.tabs.get(tid)!;
    t.zoom = delta === 0 ? 0 : Math.max(-5, Math.min(5, (t.zoom ?? 0) + delta * 0.5));
    wc.setZoomLevel(t.zoom);
    this.event({ type: 'toast', text: `Zoom ${Math.round(Math.pow(1.2, t.zoom) * 100)}%` });
    this.save();
  }

  // =====================================================================
  // banners & hand-offs
  // =====================================================================

  ask(b: Omit<Banner, 'id' | 'createdAt'>, timeoutMs = 0): Promise<string> {
    const banner: Banner = { ...b, id: uid('b'), createdAt: Date.now() };
    this.banners.push(banner);
    this.layout();
    this.pushState();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (v: string) => {
        if (timer) clearTimeout(timer);
        this.bannerWaiters.delete(banner.id);
        this.banners = this.banners.filter((x) => x.id !== banner.id);
        this.pushState();
        resolve(v);
      };
      this.bannerWaiters.set(banner.id, done);
      if (timeoutMs > 0) timer = setTimeout(() => done('timeout'), timeoutMs);
    });
  }

  respondBanner(id: string, value: string) {
    const w = this.bannerWaiters.get(id);
    if (w) w(value);
    else {
      this.banners = this.banners.filter((x) => x.id !== id);
      this.pushState();
    }
  }

  // =====================================================================
  // agent activity
  // =====================================================================

  beginActivity(source: string, label: string, tabId?: TabId | null): () => void {
    this.activityCount++;
    if (this.activityEnd) clearTimeout(this.activityEnd);
    this.activityEnd = null;
    this.activityFields = { ...this.activityFields, active: true, source, label, tabId: tabId ?? this.activeTabId() };
    this.pushState();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.activityCount = Math.max(0, this.activityCount - 1);
      if (this.activityCount === 0) {
        this.activityEnd = setTimeout(() => {
          if (this.activityCount === 0) {
            this.activityFields = { ...this.activityFields, active: false, label: null };
            for (const c of this.controllers.values()) c.call(c.main, 'pointerHide', {}, 500).catch(() => {});
            this.pushState();
          }
        }, 1500);
      }
    };
  }

  setActivityLabel(label: string, tabId?: TabId) {
    this.activityFields = { ...this.activityFields, label, tabId: tabId ?? this.activityFields.tabId };
    this.pushState();
  }

  noteClient(name: string) {
    const c = this.clients.get(name) ?? { name, lastSeenAt: 0, calls: 0 };
    c.lastSeenAt = Date.now();
    c.calls++;
    this.clients.set(name, c);
  }

  assertNotPaused() {
    if (this.activityFields.paused) throw new Error('The user paused agent control in Clickless. Stop and tell the user; they can resume from the browser.');
  }

  setPaused(paused: boolean) {
    this.activityFields = { ...this.activityFields, paused };
    if (paused) this.abortAll();
    this.pushState();
  }

  /** Registers an abortable tool call (stop button). */
  trackAbort(): AbortController {
    const ac = new AbortController();
    this.aborters.add(ac);
    return ac;
  }

  untrackAbort(ac: AbortController) {
    this.aborters.delete(ac);
  }

  abortAll() {
    for (const ac of this.aborters) ac.abort();
    this.aborters.clear();
  }

  // =====================================================================
  // page control (Browser interface)
  // =====================================================================

  /** The tab a tool call acts on; wakes it, and opens one if there is none. */
  private async toolTab(tabId?: string): Promise<{ id: TabId; ctl: PageController }> {
    let id = tabId && this.tabs.has(tabId) ? tabId : undefined;
    if (tabId && !id) throw new Error(`No tab “${tabId}”. Use the tabs tool to list tabs.`);
    id ??= this.activeTabId() ?? (await this.openTab(NEWTAB)).id;
    this.wake(id);
    const ctl = this.controllers.get(id);
    if (!ctl) throw new Error('tab has no page');
    return { id, ctl };
  }

  private actHost(): ActHost {
    return {
      controller: async (id) => (await this.toolTab(id)).ctl,
      activeTabId: () => this.activeTabId(),
      openTab: async (url, o) => (await this.openTab(url, { openerTabId: o.openerTabId, background: o.background })).id,
      activateTab: (id) => {
        if (!this.tabs.has(id)) throw new Error(`No tab “${id}”`);
        this.activateTab(id);
      },
      closeTab: (id) => this.closeTab(id),
      tabLabel: (id) => {
        const t = this.tabs.get(id);
        return t ? `“${t.title.slice(0, 60)}”` : '';
      },
      toUrl: (s) => this.toUrl(s),
      openedBy: (id, since) => this.openedLog.filter((o) => o.opener === id && o.at >= since).map((o) => o.tab),
      setLabel: (label, tabId) => this.setActivityLabel(label, tabId),
      assertNotPaused: () => this.assertNotPaused(),
    };
  }

  async observe(opts: ObserveOptions = {}): Promise<ToolResult> {
    const { id, ctl } = await this.toolTab(opts.tabId);
    let text = await ctl.observeText({ max: opts.max, text: opts.text, viewportOnly: opts.viewportOnly, query: opts.query });
    text = `tab ${id}\n${text}`;
    const images = [];
    if (opts.screenshot) {
      const shot = await ctl.capture({ marks: true });
      images.push({ data: shot.data, mimeType: shot.mimeType });
      text += '\n(screenshot attached: numbered boxes match the refs)';
    }
    return { text, images: images.length ? images : undefined, data: { tabId: id } };
  }

  async act(steps: Step[] | string, opts: ActOptions = {}): Promise<ToolResult> {
    this.assertNotPaused();
    const list = typeof steps === 'string' ? normalizeSteps(steps) : steps;
    const first = list[0];
    // a first step that opens a page doesn't need an existing tab
    const { id } = await this.toolTab(opts.tabId);
    const end = this.beginActivity(opts.source ?? 'agent', 'Working…', id);
    try {
      return await runAct(this.actHost(), id, list, { ...opts, signal: opts.signal });
    } finally {
      end();
      void first;
    }
  }

  async read(opts: ReadOptions = {}): Promise<ToolResult> {
    const { id, ctl } = await this.toolTab(opts.tabId);
    await ctl.waitReady(10000);
    const r = await ctl.call(ctl.main, 'read', { mode: opts.mode ?? 'article', links: !!opts.links }, 15000);
    let md = r.markdown || '(no readable text on this page)';
    const header = [`# ${r.title}`, r.url + (r.byline ? ` · ${r.byline}` : '')];
    if (opts.query) {
      const qs = opts.query.trim();
      let re: RegExp;
      const m = /^\/(.+)\/([a-z]*)$/.exec(qs);
      try {
        re = m ? new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i') : new RegExp(qs.split('|').map((s) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
      } catch {
        re = new RegExp(qs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }
      const paras = md.split(/\n{2,}/);
      const hits: string[] = [];
      let heading = '';
      for (let i = 0; i < paras.length; i++) {
        const p = paras[i];
        if (/^#{1,6} /.test(p)) heading = p;
        if (re.test(p)) {
          if (heading && heading !== p && !hits.includes(heading)) hits.push(heading);
          hits.push(p.length > 1500 ? p.slice(0, 1500) + '…' : p);
        }
        if (hits.join('\n\n').length > 12000) break;
      }
      md = hits.length ? hits.join('\n\n') : `Nothing on the page matches “${opts.query}”.`;
      header.push(`(paragraphs matching “${opts.query}”)`);
    } else {
      const offset = Math.max(0, opts.offset ?? 0);
      const limit = Math.max(500, Math.min(opts.limit ?? 12000, 60000));
      const total = md.length;
      if (offset > 0 || total > offset + limit) {
        md = md.slice(offset, offset + limit);
        header.push(`(characters ${offset}–${Math.min(total, offset + limit)} of ${total}${offset + limit < total ? `; read again with offset ${offset + limit} for more` : ''})`);
      }
    }
    let text = `${header.join('\n')}\n\n${md}`;
    return { text, data: { tabId: id, url: r.url, title: r.title, length: r.markdown.length } };
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<ToolResult> {
    const { id, ctl } = await this.toolTab(opts.tabId);
    await ctl.waitReady(8000);
    let clip: [number, number, number, number] | undefined;
    if (opts.target !== undefined) {
      const loc = await ctl.locate(opts.target, 'hover');
      clip = loc.res.rect;
    }
    const shot = await ctl.capture({ marks: opts.marks, fullPage: opts.fullPage, clip, maxWidth: opts.maxWidth, format: opts.format });
    const t = this.tabs.get(id);
    return {
      text: `Screenshot of tab ${id} “${t?.title ?? ''}” (${shot.width}×${shot.height}${opts.marks ? ', numbered boxes = element refs' : ''})`,
      images: [{ data: shot.data, mimeType: shot.mimeType }],
      data: { tabId: id, width: shot.width, height: shot.height },
    };
  }

  async evaluate(code: string, opts: { tabId?: TabId } = {}): Promise<ToolResult> {
    this.assertNotPaused();
    const { id, ctl } = await this.toolTab(opts.tabId);
    await ctl.waitReady(8000);
    try {
      const v = await ctl.evaluate(code);
      let s: string;
      try {
        s = typeof v === 'string' ? v : JSON.stringify(v, null, 1) ?? 'undefined';
      } catch {
        s = String(v);
      }
      if (s.length > 20000) s = s.slice(0, 20000) + `\n…(${s.length - 20000} more characters)`;
      return { text: s, data: { tabId: id, value: v } };
    } catch (err) {
      return { text: `Error: ${(err as Error).message}`, isError: true };
    }
  }

  async handoff(message: string, opts: { tabId?: TabId; timeoutMs?: number } = {}): Promise<ToolResult> {
    const { id, ctl } = await this.toolTab(opts.tabId);
    this.activateTab(id);
    this.win.focus();
    const v = await this.ask(
      {
        kind: 'handoff',
        tabId: id,
        title: 'Your agent needs you',
        detail: message,
        actions: [
          { label: 'Done, continue', value: 'done' },
          { label: 'Cancel', value: 'cancel' },
        ],
      },
      opts.timeoutMs ?? 10 * 60_000,
    );
    const after = await ctl.observeText({}).catch(() => '');
    if (v === 'done') return { text: `The user is done (${message}).\n\n${after}` };
    if (v === 'timeout') return { text: `The user did not respond in time.\n\n${after}`, isError: true };
    return { text: 'The user cancelled. Stop this task and ask them what to do.', isError: true };
  }

  headless = {
    read: (url: string, opts?: { timeoutMs?: number; maxChars?: number; signal?: AbortSignal }): Promise<HeadlessPage> => this.headlessPages.read(this.toUrl(url), opts),
    evaluate: <T = unknown>(url: string, fnSource: string, opts?: { timeoutMs?: number; waitForSelector?: string; signal?: AbortSignal }): Promise<T> =>
      this.headlessPages.evaluate<T>(this.toUrl(url), fnSource, opts),
  };

  // =====================================================================
  // AI search entry
  // =====================================================================

  startAsk(query: string, tabId?: TabId): string {
    const askId = this.ai.ask.start(query);
    this.openAskPage(askId, tabId);
    return askId;
  }

  openAskPage(askId: string, tabId?: TabId) {
    const url = `${APP_SCHEME}://ask/?id=${encodeURIComponent(askId)}`;
    const t = tabId ? this.tabs.get(tabId) : undefined;
    if (t) {
      const wc = this.wake(t.id)?.webContents;
      wc?.loadURL(url).catch(() => {});
      this.activateTab(t.id);
    } else this.openTab(url).catch(() => {});
  }

  // =====================================================================
  // import from other browsers
  // =====================================================================

  /** Imports spaces, pinned tabs, folders, favourites and open tabs from Arc, Comet, Chrome, Brave or Edge. Safe to run twice: a link already in the same folder is skipped. */
  importFrom(source: string): ImportReport {
    return this.applyImport(readSource(source));
  }

  applyImport(plan: ImportPlan): ImportReport {
    const key = (u: string) => u.replace(/#.*$/, '').replace(/\/$/, '');
    const norm = (n: string) => n.toLowerCase().replace(/\bspace\b/g, '').trim();
    const report: ImportReport = { source: plan.source, found: countPlan(plan), spaces: [], favorites: 0, skipped: 0 };
    const seenFav = new Set(Array.from(this.tabs.values()).filter((t) => t.favorite).map((t) => key(t.url)));
    let favOrder = this.maxOrder((t) => t.favorite) + 1;

    for (const sp of plan.spaces) {
      let space = this.state.spaces.find((s) => norm(s.name) === norm(sp.name));
      const created = !space;
      if (!space) {
        space = { id: uid('s'), name: sp.name.replace(/\s+space$/i, '') || sp.name, icon: sp.icon, color: SPACE_COLORS[this.state.spaces.length % SPACE_COLORS.length] };
        this.state.spaces.push(space);
      }
      const spaceId = space.id;
      // An untouched space takes the other browser's icon (Arc's 🪐 for “Personal Space”).
      if (!created && sp.icon && this.spaceTabs(spaceId).filter((t) => !t.internal).length === 0) space.icon = sp.icon;
      // Duplicates are dropped per folder / section only: the same link in two folders stays in both.
      const slot = (pinned: boolean, folderId?: string) => folderId ?? (pinned ? 'pinned' : 'today');
      const seen = new Map<string, Tab>(this.spaceTabs(spaceId).map((t) => [`${slot(t.pinned, t.folderId)} ${key(t.url)}`, t]));
      const row = { name: space.name, created, tabs: 0, folders: 0 };

      const addTab = (n: Extract<ImportNode, { kind: 'tab' }>, pinned: boolean, order: number, folderId?: string) => {
        const k = `${slot(pinned, folderId)} ${key(n.url)}`;
        const had = seen.get(k);
        if (had) {
          if (!had.favicon && n.favicon) had.favicon = n.favicon; // a re-run fills in icons
          return void report.skipped++;
        }
        const t = this.newTabRecord(n.url, { spaceId, pinned, folderId });
        seen.set(k, t);
        t.title = n.title.slice(0, 300);
        t.favicon = n.favicon;
        t.order = order;
        row.tabs++;
      };
      const folderFor = (name: string, pinned: boolean, order: number): Folder => {
        const existing = this.state.folders.find((f) => f.spaceId === spaceId && f.pinned === pinned && f.name === name);
        if (existing) return existing;
        const f: Folder = { id: uid('f'), spaceId, name: name.slice(0, 120), collapsed: true, pinned, order };
        this.state.folders.push(f);
        row.folders++;
        return f;
      };
      /** Folders are one level deep in Clickless: nested folders become “Parent / Child”, placed right after their parent. */
      const addFolder = (n: Extract<ImportNode, { kind: 'folder' }>, pinned: boolean, order: number, prefix = '') => {
        const name = prefix ? `${prefix} / ${n.name}` : n.name;
        const tabs = n.children.filter((c) => c.kind === 'tab') as Extract<ImportNode, { kind: 'tab' }>[];
        const subs = n.children.filter((c) => c.kind === 'folder') as Extract<ImportNode, { kind: 'folder' }>[];
        if (tabs.length) {
          const f = folderFor(name, pinned, order);
          tabs.forEach((t, i) => addTab(t, pinned, i, f.id));
        }
        subs.forEach((sub, i) => addFolder(sub, pinned, order + (i + 1) / (subs.length + 1) / 10 ** (prefix.split(' / ').length), name));
      };
      const addSection = (nodes: ImportNode[], pinned: boolean) => {
        const base = this.maxOrder((t) => t.spaceId === spaceId && t.pinned === pinned && !t.favorite && !t.folderId, this.state.folders.filter((f) => f.spaceId === spaceId && f.pinned === pinned)) + 1;
        nodes.forEach((n, i) => (n.kind === 'tab' ? addTab(n, pinned, base + i) : addFolder(n, pinned, base + i)));
      };

      for (const n of sp.favorites) {
        if (n.kind !== 'tab') continue;
        if (seenFav.has(key(n.url))) {
          const had = Array.from(this.tabs.values()).find((t) => t.favorite && key(t.url) === key(n.url));
          if (had && !had.favicon && n.favicon) had.favicon = n.favicon;
          continue;
        }
        seenFav.add(key(n.url));
        const t = this.newTabRecord(n.url, { spaceId });
        t.title = n.title.slice(0, 300);
        t.favicon = n.favicon;
        t.favorite = true;
        t.order = favOrder++;
        report.favorites++;
      }
      addSection(sp.pinned, true);
      addSection(sp.today, false);
      report.spaces.push(row);
    }
    this.save();
    this.pushState();
    return report;
  }

  // =====================================================================
  // housekeeping
  // =====================================================================

  private housekeeping() {
    const now = Date.now();
    const { archiveAfterHours, sleepAfterMinutes } = this.state.settings.tabs;
    const visible = new Set(this.visibleTabIds());
    for (const t of Array.from(this.tabs.values())) {
      if (visible.has(t.id)) continue;
      const live = this.live.get(t.id);
      if (archiveAfterHours > 0 && !t.pinned && !t.favorite && !t.internal && now - t.lastActiveAt > archiveAfterHours * 3600_000) {
        this.closeTab(t.id, { archive: true });
        continue;
      }
      if (sleepAfterMinutes > 0 && !t.asleep && !live?.audible && now - t.lastActiveAt > sleepAfterMinutes * 60_000 && this.activityFields.tabId !== t.id) this.sleepTab(t.id);
    }
    if (this.state.archived.length > 500) this.state.archived = this.state.archived.slice(0, 500);
    this.pushState();
  }

  openExternal(url: string) {
    if (/^https?:|^mailto:/.test(url)) electronShell.openExternal(url).catch(() => {});
  }

  copyUrl(id?: TabId) {
    const wc = this.wcOf(id);
    if (!wc) return;
    clipboard.writeText(wc.getURL());
    this.event({ type: 'toast', text: 'Copied URL', tone: 'success' });
  }

  /** Dev only: captures of the shell, the visible tab and the overlay (base64 PNG). */
  async debugCapture(): Promise<Record<string, string>> {
    const cap = async (wc: WebContents) => {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      // background windows freeze CSS animations at frame 0: show the end state instead
      await wc.insertCSS('*,*::before,*::after{animation-delay:-60s!important;animation-play-state:running!important;transition:none!important}').catch(() => '');
      await new Promise((r) => setTimeout(r, 80));
      const r = (await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })) as { data: string };
      return r.data;
    };
    const out: Record<string, string> = {};
    out.shell = await cap(this.shell.webContents);
    const id = this.activeTabId();
    const v = id ? this.views.get(id) : undefined;
    if (v) {
      out.tab = await cap(v.webContents);
      out.tabBounds = JSON.stringify(v.getBounds());
    }
    if (this.overlayState) out.overlay = await cap(this.overlay.webContents);
    return out;
  }

  async allTabsSnapshot() {
    await sleep(0);
    return this.listTabs({ all: true });
  }
}
