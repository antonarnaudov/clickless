// Domain types shared by the main process, the preloads and the UI.
// Keep this file dependency-free: it is imported everywhere.

export type TabId = string;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Space {
  id: string;
  name: string;
  /** Emoji shown in the space switcher. */
  icon: string;
  /** Accent colour (hex). The UI derives the sidebar gradient from it. */
  color: string;
  /** The pinned section is folded away in the sidebar. */
  collapsed?: boolean;
  /** The Today section is folded away. */
  todayCollapsed?: boolean;
}

export interface Folder {
  id: string;
  spaceId: string;
  name: string;
  collapsed: boolean;
  /** Folders live in the pinned section (true) or in Today (false). */
  pinned: boolean;
  order: number;
  /** Set for a folder inside another folder. */
  parentId?: string;
  /** Folder colour (hex); without one a colour is picked from its name. */
  color?: string;
  /** An emoji shown instead of the folder icon. */
  icon?: string;
}

export interface Tab {
  id: TabId;
  spaceId: string;
  url: string;
  title: string;
  /** Pinned tabs and favourites remember where they were saved: closing one unloads it and returns here. */
  savedUrl?: string;
  savedTitle?: string;
  favicon?: string;
  /** Favourites are shown as tiles at the top of the sidebar in every space. */
  favorite: boolean;
  /** Pinned section of its space (survives "clear Today" and auto-archive). */
  pinned: boolean;
  folderId?: string;
  /** Sort key within its section / folder. Folders share the same namespace. */
  order: number;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  muted: boolean;
  /** No live web contents; it is created again when the tab is activated. */
  asleep: boolean;
  createdAt: number;
  lastActiveAt: number;
  zoom: number;
  /** Load error shown by the UI instead of the page, if any. */
  error?: string;
  /** Internal page (clickless://…) rather than a website. */
  internal: boolean;
}

export interface ArchivedTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  spaceId: string;
  archivedAt: number;
}

export interface HistoryEntry {
  url: string;
  title: string;
  favicon?: string;
  visitCount: number;
  lastVisitAt: number;
}

export interface Suggestion {
  kind: 'tab' | 'history' | 'archived' | 'url' | 'search' | 'ask' | 'command';
  title: string;
  subtitle?: string;
  url?: string;
  tabId?: TabId;
  archivedId?: string;
  favicon?: string;
  /** For kind 'command': the command id the UI should run. */
  command?: string;
}

export interface Download {
  id: string;
  filename: string;
  path: string;
  url: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  startedAt: number;
}

/** Small notices above the page: permission prompts, agent hand-offs, downloads. */
export interface Banner {
  id: string;
  kind: 'permission' | 'handoff' | 'info' | 'error';
  tabId?: TabId;
  title: string;
  detail?: string;
  /** Buttons, first one is primary. `value` is sent back with banner.respond. */
  actions: { label: string; value: string }[];
  createdAt: number;
}

/** Live agent activity, for the glow around the page and the status pill. */
export interface AgentActivity {
  /** Something is driving the browser right now. */
  active: boolean;
  /** Who: "Clickless agent", "claude-code", "cursor", "http", … */
  source: string | null;
  tabId: TabId | null;
  /** Human-readable current step, e.g. 'Click “Sign in”'. */
  label: string | null;
  /** The user paused all agent control (tool calls are refused while true). */
  paused: boolean;
  /** Clients connected over MCP / HTTP in the last minutes. */
  clients: { name: string; lastSeenAt: number; calls: number }[];
}

export interface FindState {
  query: string;
  activeMatch: number;
  matches: number;
}

export type OverlayState =
  | { kind: 'palette'; mode: 'new-tab' | 'navigate' | 'commands' | 'ask'; initial?: string; tabId?: TabId }
  | { kind: 'settings'; section?: 'general' | 'ai' | 'agents' | 'search' | 'tabs' | 'backup' }
  /** An agent working in its own profile asks for some of the user's tabs. */
  | { kind: 'share-tabs'; requestId: string; clientId: string; clientName: string; reason: string; preselect: string[] }
  | { kind: 'organize'; spaceId: string; loading: boolean; proposal: OrganizeProposal | null; error?: string }
  | { kind: 'space'; spaceId?: string };

export interface OrganizeProposal {
  spaceId: string;
  groups: { name: string; emoji?: string; tabIds: TabId[] }[];
  /** Duplicates / dead tabs the organizer suggests closing. */
  close: TabId[];
  /** Cleaner titles for noisy tabs. */
  renames: { tabId: TabId; title: string }[];
  /** 'ai' when a model produced it, 'heuristic' when grouped by site. */
  source: 'ai' | 'heuristic';
}

// ---------- AI settings ----------

export type ProviderKind = 'anthropic' | 'openai' | 'claude-code';

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  /** Display name: "Anthropic", "Ollama", "LM Studio", "OpenRouter", … */
  label: string;
  /** For openai-compatible: e.g. http://localhost:11434/v1. Anthropic: optional override. */
  baseURL?: string;
  model: string;
  /** The API key lives encrypted in the main process; the UI only sees this flag. */
  hasKey: boolean;
  /** Whether the model accepts images (screenshots). */
  vision: boolean;
  /** Anthropic only: effort for thinking models. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** claude-code only: path to the `claude` binary (default: found on PATH). */
  binary?: string;
}

/** Where encrypted backups go. */
export type BackupTarget = { kind: 'folder'; folder: string } | { kind: 'github'; repo: string };

export interface Settings {
  searchEngine: 'google' | 'duckduckgo' | 'bing' | 'brave' | 'kagi' | 'custom';
  /** Custom engine, `%s` is replaced by the query. */
  customSearchURL?: string;
  /** How the AI search and the `search` tool fetch results. Browser-based backends need no key. */
  askBackend: 'duckduckgo' | 'google' | 'bing' | 'brave' | 'searxng';
  searxngURL?: string;
  /** How many result pages AI search reads before answering. */
  askReadPages: number;
  providers: ProviderConfig[];
  /** Provider for the built-in agent panel. */
  agentProviderId: string | null;
  /** Provider for AI search answers and tab organizing (falls back to the agent provider). */
  askProviderId: string | null;
  control: {
    /** Local control API (HTTP + MCP) on 127.0.0.1. */
    enabled: boolean;
    port: number;
    /** Expose a Chrome DevTools Protocol port for Playwright / browser-use / Puppeteer. */
    cdpPort: number | null;
  };
  agent: {
    maxSteps: number;
    /** Draw the animated agent cursor and highlights in the page. */
    showCursor: boolean;
    /** Cursor travel time per action, ms. 0 = instant. */
    cursorMs: number;
    /** How the agent answers JS confirm()/prompt() dialogs it triggers. */
    dialogs: 'accept' | 'dismiss';
  };
  tabs: {
    /** Today tabs not touched for this long are archived (0 = never). */
    archiveAfterHours: number;
    /** Background tabs are put to sleep after this long (0 = never). */
    sleepAfterMinutes: number;
  };
  /** Agents that connect over MCP work in their own browser profile and window ('own'), or in yours ('shared'). */
  agents: {
    defaultAccess: 'own' | 'shared';
    /** Per agent client id (claude-code, codex, gemini-cli, …). */
    access: Record<string, 'own' | 'shared'>;
  };
  /** Address-bar suggestions from DuckDuckGo while typing (sends what you type to DuckDuckGo). */
  searchSuggestions: boolean;
  /** Optional encrypted backups. Off until a target and a passphrase are set. */
  backup: {
    target: BackupTarget | null;
    schedule: 'daily' | 'weekly' | 'manual';
    /** Folder targets keep this many backups (GitHub keeps every version in its history). */
    keep: number;
    lastAt: number | null;
    lastWhere: string | null;
    lastError: string | null;
  };
  appearance: {
    theme: 'system' | 'light' | 'dark';
    /** Show the URL above the page instead of only in the sidebar. */
    compactUrl: boolean;
  };
}

/** What the UI sees about the local control API. */
export interface ControlInfo {
  running: boolean;
  port: number | null;
  /** http://127.0.0.1:<port> */
  url: string | null;
  mcpUrl: string | null;
  cdpPort: number | null;
  /** Where the CLI finds the port and token. */
  discoveryFile: string;
  error?: string;
}

/** The whole UI state, pushed from main to the shell and the overlay on every change. */
export interface UIState {
  spaces: Space[];
  activeSpaceId: string;
  /** All tabs of all spaces (favorites included), in no particular order: sort by `order`. */
  tabs: Tab[];
  folders: Folder[];
  /** The tab shown in the main viewport (may be a favorite from any space). */
  activeTabId: TabId | null;
  /** Two tabs side by side. The first is the active one. */
  split: { tabIds: TabId[]; sizes: number[] } | null;
  sidebar: { visible: boolean; width: number };
  panel: { open: boolean; width: number };
  overlay: OverlayState | null;
  find: FindState | null;
  banners: Banner[];
  downloads: Download[];
  agent: AgentActivity;
  settings: Settings;
  control: ControlInfo;
  platform: 'darwin' | 'win32' | 'linux';
  /** True while the window is fullscreen (traffic lights hidden). */
  fullscreen: boolean;
  /** Backup status (secrets are never sent to the UI, only whether they're set). */
  backup: { hasPassphrase: boolean; hasGithubToken: boolean; running: boolean };
  /** This window is the user's browser, or an agent's own browser profile. */
  profile: { kind: 'user' } | { kind: 'agent'; id: string; name: string };
  /** Agents with their own browser profile (main window only). */
  agentProfiles: AgentProfileStatus[];
}

export interface AgentProfileStatus {
  /** Agent client id: claude-code, codex, gemini-cli, … */
  id: string;
  name: string;
  /** Its browser process is running. */
  running: boolean;
  lastUsedAt: number;
  calls: number;
  tabs?: number;
  access: 'own' | 'shared';
}

// ---------- Agent chat (the AI side panel) ----------

export type ChatItem =
  | { id: string; kind: 'user'; text: string; at: number }
  | { id: string; kind: 'assistant'; text: string; at: number; streaming?: boolean }
  | {
      id: string;
      kind: 'tool';
      name: string;
      /** One-line summary of the call, e.g. 'act: click “Sign in”, type “Email”'. */
      summary: string;
      status: 'running' | 'done' | 'error';
      /** Short result preview (first lines). */
      result?: string;
      /** data: URL of a screenshot the tool returned. */
      image?: string;
      at: number;
      ms?: number;
    }
  | { id: string; kind: 'error'; text: string; at: number }
  | { id: string; kind: 'notice'; text: string; at: number };

export interface ChatState {
  items: ChatItem[];
  running: boolean;
  /** "Claude Opus 5.5 · Anthropic", "qwen3:14b · Ollama", null when no provider is set. */
  providerLabel: string | null;
  /** Steps taken in the current run / limit. */
  steps: number;
  maxSteps: number;
}

// ---------- AI search ----------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  favicon?: string;
}

export interface AskSource extends SearchResult {
  n: number;
  /** Whether the page was read (false = only the snippet was used). */
  read: boolean;
}

export interface AskTurn {
  query: string;
  status: 'searching' | 'reading' | 'answering' | 'done' | 'error' | 'stopped';
  sources: AskSource[];
  /** Markdown with [n] citations. */
  answer: string;
  error?: string;
  startedAt: number;
  ms?: number;
}

export interface AskState {
  id: string;
  turns: AskTurn[];
  providerLabel: string | null;
  /** Related follow-up questions suggested after the last answer. */
  related: string[];
}

// ---------------------------------------------------------------------------
// import from other browsers
// ---------------------------------------------------------------------------

export interface ImportSource {
  /** arc | comet | chrome | brave | edge */
  id: string;
  name: string;
  /** Its data was found on this Mac. */
  available: boolean;
}

export interface ImportReport {
  source: string;
  /** What the other browser had. */
  found: { tabs: number; folders: number };
  /** What landed in each Clickless space. */
  spaces: { name: string; created: boolean; tabs: number; folders: number }[];
  favorites: number;
  /** Already in that folder (or listed twice there in the source). */
  skipped: number;
}
