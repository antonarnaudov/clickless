// Main-process contracts between the browser core, the control API (MCP/HTTP), the tools
// and the AI layer. The browser core implements `Browser`; tools and AI only use this interface.

import type { Step } from '../shared/steps';
import type {
  AskState,
  ChatState,
  OrganizeProposal,
  ProviderConfig,
  SearchResult,
  Settings,
  Tab,
  TabId,
} from '../shared/types';

export interface ImageData {
  /** base64, no data: prefix */
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
}

/** What every tool returns. Text first: it is what models read best. */
export interface ToolResult {
  text: string;
  images?: ImageData[];
  isError?: boolean;
  /** Structured data for HTTP/CLI callers (not shown to models). */
  data?: unknown;
}

export interface ObserveOptions {
  tabId?: TabId;
  /** Only elements / headings whose text matches (case-insensitive substring, or several separated by |). */
  query?: string;
  /** Include short visible text blocks between elements (default false; use read for content). */
  text?: boolean;
  /** Only what is inside the viewport (default false: the whole page, viewport first). */
  viewportOnly?: boolean;
  /** Max elements listed (default 200). */
  max?: number;
  /** Attach a screenshot with numbered marks matching the refs. */
  screenshot?: boolean;
}

export interface ActOptions {
  tabId?: TabId;
  /** Include a fresh observe after the steps: 'auto' (default: when the page changed a lot), 'always', 'never'. */
  observe?: 'auto' | 'always' | 'never';
  /** Attach a screenshot after the steps. */
  screenshot?: boolean;
  /** Keep running the remaining steps after a failed one (default false). */
  continueOnError?: boolean;
  signal?: AbortSignal;
  /** Who is acting, for the UI ("claude-code", "Clickless agent"). */
  source?: string;
}

export interface ReadOptions {
  tabId?: TabId;
  /** 'article' = main content (default), 'full' = all visible text incl. navigation. */
  mode?: 'article' | 'full';
  /** Return only paragraphs matching this (case-insensitive substring or /regex/). */
  query?: string;
  /** Character window for long pages. */
  offset?: number;
  limit?: number;
  /** Append the list of links on the page. */
  links?: boolean;
}

export interface ScreenshotOptions {
  tabId?: TabId;
  /** Draw numbered boxes on interactive elements (set-of-marks). */
  marks?: boolean;
  fullPage?: boolean;
  /** Element target to crop to. */
  target?: string | number;
  /** Max width of the returned image (default 1280). */
  maxWidth?: number;
  format?: 'png' | 'jpeg';
}

export interface HeadlessPage {
  url: string;
  title: string;
  markdown: string;
  error?: string;
}

export interface Browser {
  // ----- tabs -----
  listTabs(opts?: { spaceId?: string; all?: boolean }): Tab[];
  activeTab(): Tab | null;
  getTab(tabId: TabId): Tab | null;
  openTab(url: string, opts?: { background?: boolean; spaceId?: string; source?: string }): Promise<Tab>;
  closeTab(tabId: TabId): void;
  activateTab(tabId: TabId): void;
  /** Resolves "url or search terms" to a URL using the user's search engine. */
  toUrl(input: string): string;

  // ----- page control (the heart of the agent API) -----
  observe(opts?: ObserveOptions): Promise<ToolResult>;
  act(steps: Step[], opts?: ActOptions): Promise<ToolResult>;
  read(opts?: ReadOptions): Promise<ToolResult>;
  screenshot(opts?: ScreenshotOptions): Promise<ToolResult>;
  evaluate(code: string, opts?: { tabId?: TabId }): Promise<ToolResult>;
  /** Ask the human to do something in the visible browser (log in, solve a captcha). */
  handoff(message: string, opts?: { tabId?: TabId; timeoutMs?: number }): Promise<ToolResult>;

  // ----- background pages (search, reading many pages in parallel) -----
  headless: {
    /** Loads a URL in a hidden page and returns its readable content as markdown. */
    read(url: string, opts?: { timeoutMs?: number; maxChars?: number; signal?: AbortSignal }): Promise<HeadlessPage>;
    /**
     * Loads a URL in a hidden page and runs `fnSource` (a JS function expression, e.g.
     * "() => [...document.querySelectorAll('a')].map(a => a.href)") in it; returns its JSON result.
     */
    evaluate<T = unknown>(url: string, fnSource: string, opts?: { timeoutMs?: number; waitForSelector?: string; signal?: AbortSignal }): Promise<T>;
  };

  // ----- agent activity (UI glow, stop button) -----
  /** Marks an agent as acting. Returns a function that ends the activity. */
  beginActivity(source: string, label: string, tabId?: TabId | null): () => void;
  /** Throws if the user paused agents. */
  assertNotPaused(): void;

  settings(): Settings;
}

// ----- Tools: one registry for MCP, HTTP, the CLI and the built-in agent -----

export interface JSONSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: unknown[];
  additionalProperties?: boolean | JSONSchema;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface ToolContext {
  browser: Browser;
  /** "claude-code", "Clickless agent", "http", "cli" … */
  source: string;
  signal?: AbortSignal;
}

export interface ToolDef {
  name: string;
  /** First sentence is the summary; keep the rest short and practical. */
  description: string;
  inputSchema: JSONSchema;
  /** Tools that only read (observe, read, screenshot, tabs list) don't light the agent glow. */
  readOnly?: boolean;
  handler(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolRegistry {
  list(): ToolDef[];
  get(name: string): ToolDef | undefined;
  call(name: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
  /** Short usage guide for agents (MCP server instructions, system prompts). */
  instructions: string;
}

// ----- AI layer (src/main/ai) -----

export interface AIDeps {
  browser: Browser;
  tools: ToolRegistry;
  settings(): Settings;
  /** Decrypted API key for a provider, if one is stored. */
  getSecret(providerId: string): string | undefined;
  /** HTTP + MCP endpoint of the local control API, with token (for the Claude Code provider). */
  control(): { mcpUrl: string; token: string } | null;
  emitChat(state: ChatState): void;
  emitAsk(state: AskState): void;
  /** Opens clickless://ask?id=… (in tabId if given). */
  openAskPage(askId: string, tabId?: TabId): void;
}

export interface AI {
  agent: {
    send(text: string, tabId?: TabId): void;
    stop(): void;
    reset(): void;
    state(): ChatState;
    /** Runs a task to completion without the UI thread (HTTP /v1/agent, CLI `clickless agent`). */
    run(task: string, opts?: { tabId?: TabId; signal?: AbortSignal; onEvent?: (e: { type: string; text?: string }) => void }): Promise<{ text: string; steps: number }>;
  };
  ask: {
    /** Starts an AI search and returns its id; progress goes out through emitAsk. */
    start(query: string): string;
    followup(askId: string, query: string): void;
    stop(askId: string): void;
    state(askId: string): AskState | null;
  };
  /** Web search through the browser (no API key) + optional reading of the top results. */
  search(query: string, opts?: { limit?: number; read?: number; signal?: AbortSignal }): Promise<{ results: SearchResult[]; pages: { n: number; url: string; title: string; markdown: string }[] }>;
  organize(spaceId: string): Promise<OrganizeProposal>;
  testProvider(providerId: string): Promise<{ ok: boolean; message: string; ms?: number }>;
  listModels(providerId: string): Promise<string[]>;
  /** Display label for a provider, e.g. "Claude Opus 5.5 · Anthropic". */
  providerLabel(p: ProviderConfig | undefined): string | null;
}

export type CreateAI = (deps: AIDeps) => AI;
