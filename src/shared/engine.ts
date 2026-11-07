// RPC contract between the main process and the content engine that runs in every frame
// (src/preload/content.ts). Refs here are frame-local; main maps them to global refs.

export interface FrameElement {
  ref: number;
  role: string;
  name: string;
  tag: string;
  inputType?: string;
  value?: string;
  placeholder?: string;
  checked?: boolean | 'mixed';
  pressed?: boolean;
  selected?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  required?: boolean;
  focused?: boolean;
  readonly?: boolean;
  href?: string;
  /** First options of a <select>/listbox. */
  options?: string[];
  optionCount?: number;
  /** Viewport rect in frame CSS px: x, y, w, h. */
  rect: [number, number, number, number];
  inView: boolean;
  /** Nearest landmark: "nav", "header", "footer", "main", "aside", "form", "search", "dialog" (+ name). */
  landmark?: string;
  /** Inside an open modal dialog. */
  inDialog?: boolean;
}

export type SnapItem =
  | { k: 'el'; el: FrameElement }
  | { k: 'h'; level: number; text: string; inView: boolean }
  | { k: 't'; text: string; inView: boolean };

export interface FrameSnapshot {
  /** Random id of this document's engine instance (refs are per document). */
  doc: string;
  url: string;
  title: string;
  items: SnapItem[];
  /** Total interactive elements found (items may be capped). */
  total: number;
  viewport: { width: number; height: number; scrollX: number; scrollY: number; scrollHeight: number; scrollWidth: number };
  /** The page scrolls inside a container rather than the window. */
  scroller?: string;
  /** An open modal dialog that blocks the rest of the page. */
  dialog?: string;
  /** Element that has focus (frame-local ref) if it is listed. */
  focusedRef?: number;
  /** Page is still loading (document.readyState). */
  readyState: DocumentReadyState;
}

export interface SnapshotParams {
  max: number;
  text: boolean;
  viewportOnly: boolean;
}

export type RpcTarget =
  | { ref: number }
  | { text: string; exact?: boolean }
  | { css: string }
  | { x: number; y: number };

export interface ResolveParams {
  target: RpcTarget;
  /** The action we resolve for; steers role preference ("type" prefers text fields). */
  action: string;
  /** Scroll it into view (default true). */
  scroll?: boolean;
  /** If the previous ref went stale, re-find by these. */
  fallbackName?: string;
  fallbackRole?: string;
}

export interface Resolved {
  ok: true;
  ref: number;
  role: string;
  name: string;
  tag: string;
  /** Click point, frame viewport CSS px. */
  x: number;
  y: number;
  rect: [number, number, number, number];
  editable: boolean;
  inputType?: string;
  isSelect: boolean;
  isFileInput: boolean;
  isCheckable: boolean;
  checked?: boolean;
  disabled?: boolean;
  /** Something else is on top of the click point. */
  obscuredBy?: string;
  /** How many elements matched (text targets). */
  matches: number;
  /** How it was found, for the result text: "ref", "text", "css", "stale-ref→text". */
  via: string;
  doc: string;
}

export interface ResolveFailure {
  ok: false;
  error: string;
  /** Closest elements (frame-local refs; main maps them to global refs), so the agent can retry without observing. */
  suggestions?: { ref: number; role: string; name: string }[];
  doc?: string;
}

export interface ReadParams {
  mode: 'article' | 'full';
  links: boolean;
}

export interface ReadResult {
  url: string;
  title: string;
  byline?: string;
  siteName?: string;
  markdown: string;
  links?: { text: string; href: string }[];
}

export interface WatchResult {
  /** Visible text that appeared since the watch started (deduped, capped). */
  added: string[];
  /** Text of alerts / status / toasts that appeared. */
  alerts: string[];
  mutations: number;
  /** ms since the last DOM mutation. */
  quietMs: number;
}

export interface FrameChildRect {
  name: string;
  src: string;
  rect: [number, number, number, number];
}

/** Methods the content engine answers. */
export interface EngineMethods {
  ping(): { url: string; top: boolean; quietMs: number; readyState: DocumentReadyState; doc: string };
  snapshot(p: SnapshotParams): FrameSnapshot;
  resolve(p: ResolveParams): Resolved | ResolveFailure;
  focus(p: { ref: number }): boolean;
  /** Selects the content of a text field (so the next insertText replaces it). Returns current value length. */
  selectAll(p: { ref: number }): number;
  /** Sets a native <select>. Returns chosen labels or an error listing options. */
  selectOption(p: { ref: number; values: string[] }): { ok: true; chosen: string[] } | { ok: false; error: string; options: string[] };
  /** Native value setter + input/change events (fallback for fields that ignore typing). */
  setValue(p: { ref: number; value: string }): boolean;
  isChecked(p: { ref: number }): boolean | null;
  /** Current value of a form field (null if not a field). */
  getValue(p: { ref: number }): string | null;
  domClick(p: { ref: number }): boolean;
  scrollBy(p: { dx: number; dy: number; ref?: number }): { scrollY: number; scrollHeight: number; atEnd: boolean; atTop: boolean };
  scrollTo(p: { position: 'top' | 'bottom' }): { scrollY: number; scrollHeight: number };
  scrollIntoView(p: { ref: number }): boolean;
  watchStart(): boolean;
  watchCollect(): WatchResult;
  /** Waits (in-page) for a condition. */
  waitFor(p: { text?: string; gone?: string; selector?: string; timeout: number }): { ok: boolean; ms: number };
  hasText(p: { text: string }): boolean;
  read(p: ReadParams): ReadResult;
  childFrames(): FrameChildRect[];
  /** Top frame only: agent cursor and highlights. */
  pointer(p: { x: number; y: number; label?: string; rect?: [number, number, number, number]; ms: number; click?: boolean }): boolean;
  pointerHide(): boolean;
  marks(p: { boxes: { n: number; rect: [number, number, number, number] }[] }): boolean;
  clearMarks(): boolean;
  /** Tags an element with an attribute so CDP can find it (file uploads). */
  tag(p: { ref: number; token: string }): boolean;
  /** Evaluates an expression in the page's isolated world (not the page's own JS world). */
  evaluate(p: { code: string }): unknown;
  /** Runs a function expression and returns its JSON result (headless extraction). */
  run(p: { fn: string }): unknown;
}

export type EngineMethod = keyof EngineMethods;

export interface RpcRequest {
  id: number;
  method: EngineMethod;
  params: unknown;
}

export interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}
