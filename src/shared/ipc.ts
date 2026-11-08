// The contract between the main process and every UI surface (shell, overlay, internal pages).
// Renderers call `window.clickless.cmd(...)` / `window.clickless.query(...)` and subscribe with `on*`.

import type {
  ArchivedTab,
  AskState,
  BackupTarget,
  ChatState,
  HistoryEntry,
  ImportSource,
  OrganizeProposal,
  OverlayState,
  ProviderConfig,
  Rect,
  Settings,
  Space,
  Suggestion,
  TabId,
  UIState,
} from './types';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export type Command =
  // ----- tabs -----
  /** Opens a tab. `url` may be search terms. Returns the new TabId. */
  | { type: 'tab.new'; url?: string; spaceId?: string; background?: boolean; pinned?: boolean; folderId?: string }
  | { type: 'tab.activate'; tabId: TabId }
  | { type: 'tab.close'; tabId: TabId }
  /** Navigate to a URL or search terms. */
  | { type: 'tab.navigate'; tabId?: TabId; input: string }
  | { type: 'tab.back'; tabId?: TabId }
  | { type: 'tab.forward'; tabId?: TabId }
  | { type: 'tab.reload'; tabId?: TabId; hard?: boolean }
  | { type: 'tab.stop'; tabId?: TabId }
  | { type: 'tab.update'; tabId: TabId; patch: { favorite?: boolean; pinned?: boolean; title?: string; muted?: boolean } }
  /**
   * Drag & drop. Moves a tab into a section (pinned / today) of a space, optionally into a folder,
   * placed before `beforeId` (a tab or folder id in that section; null/undefined = at the end).
   */
  | { type: 'tab.move'; tabId: TabId; spaceId?: string; pinned?: boolean; favorite?: boolean; folderId?: string | null; beforeId?: string | null }
  | { type: 'tab.duplicate'; tabId: TabId }
  /** Reopens the last closed tab, or a specific one from recentlyClosed. */
  | { type: 'tab.reopenClosed'; closedId?: string }
  /** Opens the History page. */
  | { type: 'ui.history' }
  | { type: 'history.delete'; urls: string[] }
  /** Clears history visited since `since` (ms since epoch), or all of it. */
  | { type: 'history.clear'; since?: number }
  | { type: 'tab.restoreArchived'; archivedId: string }
  /** Arc's "Clear": archives every unpinned tab of the space. */
  | { type: 'tabs.clearToday'; spaceId?: string }
  /** Ctrl+Tab style: activate next/previous tab in sidebar order. */
  | { type: 'tabs.cycle'; dir: 1 | -1 }
  /** Cmd+1..9: activate the n-th tab of the sidebar (favorites, pinned, today order). */
  | { type: 'tabs.activateIndex'; index: number }
  // ----- folders -----
  /** Returns the new folder id. */
  | { type: 'folder.create'; spaceId?: string; name?: string; pinned?: boolean; tabIds?: TabId[] }
  | { type: 'folder.update'; folderId: string; patch: { name?: string; collapsed?: boolean } }
  | { type: 'folder.delete'; folderId: string; closeTabs?: boolean }
  | { type: 'folder.move'; folderId: string; pinned?: boolean; beforeId?: string | null }
  // ----- spaces -----
  /** Returns the new space id. */
  | { type: 'space.create'; name?: string; icon?: string; color?: string }
  | { type: 'space.update'; spaceId: string; patch: Partial<Omit<Space, 'id'>> }
  | { type: 'space.delete'; spaceId: string }
  | { type: 'space.activate'; spaceId: string }
  | { type: 'space.cycle'; dir: 1 | -1 }
  // ----- layout & window -----
  /** The shell reports where tab views go, in window CSS pixels: one rect, or two in split view. */
  | { type: 'ui.viewports'; rects: Rect[] }
  | { type: 'ui.sidebar'; visible?: boolean; width?: number }
  | { type: 'ui.panel'; open?: boolean; width?: number }
  /** Open / switch / close (null) the overlay layer: command palette, settings, organizer, space editor. */
  | { type: 'ui.overlay'; overlay: OverlayState | null }
  /** Sets the split panes (2–4 tabs, left to right) or clears it with null. With tabIds null, `sizes`/`ratio` resize the current split. */
  | { type: 'ui.split'; tabIds: TabId[] | null; sizes?: number[]; ratio?: number }
  /** Adds a tab to the split at a position (starts one with the active tab), or moves it there. */
  | { type: 'split.insert'; tabId: TabId; index: number }
  /** Puts a tab into pane `index` (swaps if it's already in another pane). */
  | { type: 'split.replace'; tabId: TabId; index: number }
  /** Takes a tab out of the split; the tab stays open. */
  | { type: 'split.remove'; tabId: TabId }
  /** Lifts the page views off while something is dragged over them (the shell gets snapshots in a 'lift' event). */
  | { type: 'ui.dragLift'; on: boolean }
  | { type: 'ui.find'; query?: string; next?: boolean; back?: boolean; close?: boolean }
  | { type: 'ui.zoom'; tabId?: TabId; delta: 1 | -1 | 0 }
  | { type: 'ui.devtools'; tabId?: TabId }
  | { type: 'ui.copyUrl'; tabId?: TabId }
  /** Gives keyboard focus back to the page (e.g. after Escape in the sidebar). */
  | { type: 'ui.focusPage' }
  | { type: 'banner.respond'; bannerId: string; value: string }
  | { type: 'download.open'; id: string }
  | { type: 'download.reveal'; id: string }
  | { type: 'download.clear' }
  | { type: 'app.openExternal'; url: string }
  // ----- AI -----
  /** Send a message to the built-in agent (side panel). Uses the active tab unless tabId is given. */
  | { type: 'agent.send'; text: string; tabId?: TabId }
  | { type: 'agent.stop' }
  | { type: 'agent.reset' }
  /** Pause / resume every agent (built-in and external MCP/HTTP clients). */
  | { type: 'agent.pause'; paused: boolean }
  /** AI search. Opens clickless://ask?id=… in a new tab (or the given tab) and returns the ask id. */
  | { type: 'ask.start'; query: string; tabId?: TabId }
  | { type: 'ask.followup'; askId: string; query: string }
  | { type: 'ask.stop'; askId: string }
  /** Runs the tab organizer for a space; the result appears in the 'organize' overlay. */
  | { type: 'organize.start'; spaceId?: string }
  | { type: 'organize.apply'; proposal: OrganizeProposal }
  // ----- settings -----
  | { type: 'settings.update'; patch: DeepPartial<Settings> }
  /** Adds or replaces a provider. `apiKey`: undefined = keep, null = remove, string = set. Returns its id. */
  | { type: 'provider.upsert'; provider: Omit<ProviderConfig, 'hasKey' | 'id'> & { id?: string }; apiKey?: string | null }
  | { type: 'provider.remove'; providerId: string }
  | { type: 'control.regenerateToken' }
  // ----- import -----
  /** Imports spaces, pinned tabs, folders, favourites and open tabs from another browser on this Mac. Returns an ImportReport. */
  | { type: 'import.run'; source: string }
  // ----- agent profiles -----
  /** Answer to an agent's request_tabs: the tabs to share (copies open in its window), or null to decline. */
  | { type: 'agents.share'; requestId: string; tabIds: TabId[] | null }
  /** Where an agent works: its own profile ('own'), the user's ('shared'), or back to the default (null). */
  | { type: 'agents.access'; clientId: string; access: 'own' | 'shared' | null }
  | { type: 'agents.defaultAccess'; access: 'own' | 'shared' }
  /** Brings an agent's own browser window to the front (starting it if needed). */
  | { type: 'agents.show'; clientId: string }
  /** Quits an agent's browser and deletes its profile (cookies, logins, tabs). */
  | { type: 'agents.reset'; clientId: string }
  // ----- backup (optional, encrypted) -----
  /** Sets where backups go, how often, and the passphrase / GitHub token (null removes, undefined keeps). */
  | { type: 'backup.configure'; target?: BackupTarget | null; schedule?: Settings['backup']['schedule']; keep?: number; passphrase?: string | null; githubToken?: string | null }
  /** Opens a folder picker; returns the chosen path or null. */
  | { type: 'backup.chooseFolder' }
  /** Backs up now. Returns { where, at, bytes }. */
  | { type: 'backup.run' }
  /** Replaces this profile with a backup (a file, or the latest at the configured target) and relaunches. */
  | { type: 'backup.restore'; from: 'file' | 'target'; file?: string; passphrase?: string };

export type CommandType = Command['type'];

export interface QueryMap {
  /** Command palette suggestions: open tabs, history, archived tabs, search, ask. */
  suggest: { args: { input: string; limit?: number }; result: Suggestion[] };
  archived: { args: { query?: string; limit?: number }; result: ArchivedTab[] };
  history: { args: { query?: string; limit?: number }; result: HistoryEntry[] };
  providerTest: { args: { providerId: string }; result: { ok: boolean; message: string; ms?: number } };
  providerModels: { args: { providerId: string }; result: string[] };
  /** Everything needed to connect an external agent. Includes the secret token. */
  controlSecrets: {
    args: Record<string, never>;
    result: {
      token: string;
      mcpUrl: string;
      httpUrl: string;
      /** Ready-to-paste commands / configs. */
      claudeCodeCommand: string;
      mcpJson: string;
      curlExample: string;
      cliExample: string;
      /** How to start the stdio MCP bridge (no token needed: it reads the discovery file). */
      stdio: { command: string; args: string[]; env?: Record<string, string> };
    };
  };
  askState: { args: { askId: string }; result: AskState | null };
  chatState: { args: Record<string, never>; result: ChatState };
  state: { args: Record<string, never>; result: UIState };
  /** Browsers Clickless can import from, and whether their data is on this Mac. */
  importSources: { args: Record<string, never>; result: ImportSource[] };
  recentlyClosed: { args: Record<string, never>; result: { id: string; url: string; title: string; favicon?: string; closedAt: number }[] };
}

export type QueryName = keyof QueryMap;

/** Shortcuts / menu actions forwarded from main to the shell or overlay. */
export type ShellEvent =
  | { type: 'focus-sidebar-url' }
  | { type: 'find-open' }
  | { type: 'panel-focus' }
  | { type: 'toast'; text: string; tone?: 'info' | 'success' | 'error' }
  /** Snapshots of the visible pages while they're lifted for a drag (null when they're back). */
  | { type: 'lift'; shots: Record<string, string> | null };

/** `window.clickless` in the shell, the overlay and clickless:// internal pages. */
export interface ClicklessAPI {
  /** Which surface this is: the window chrome, the overlay layer, or an internal page. */
  surface: 'shell' | 'overlay' | 'internal';
  platform: 'darwin' | 'win32' | 'linux';
  cmd(command: Command): Promise<any>;
  query<K extends QueryName>(name: K, args: QueryMap[K]['args']): Promise<QueryMap[K]['result']>;
  onState(cb: (state: UIState) => void): () => void;
  onChat(cb: (chat: ChatState) => void): () => void;
  onAsk(cb: (ask: AskState) => void): () => void;
  onEvent(cb: (event: ShellEvent) => void): () => void;
}

/** IPC channel names. */
export const IPC = {
  cmd: 'clickless:cmd',
  query: 'clickless:query',
  state: 'clickless:state',
  chat: 'clickless:chat',
  ask: 'clickless:ask',
  event: 'clickless:event',
  /** main → frame content engine */
  rpc: 'clickless:rpc',
  /** frame content engine → main */
  rpcResult: 'clickless:rpc-result',
  /** frame → main, unsolicited (e.g. page became interactive) */
  frameEvent: 'clickless:frame-event',
} as const;

/** Commands internal pages (clickless://newtab, clickless://ask) may send. Everything else is refused. */
export const INTERNAL_PAGE_COMMANDS: CommandType[] = [
  'tab.navigate',
  'tab.new',
  'ask.start',
  'ask.followup',
  'ask.stop',
  'ui.overlay',
  'agent.send',
  'ui.panel',
  'app.openExternal',
  'tab.reopenClosed',
  'history.delete',
  'history.clear',
];
export const INTERNAL_PAGE_QUERIES: QueryName[] = ['suggest', 'askState', 'history', 'state', 'recentlyClosed'];
