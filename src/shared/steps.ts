// The action language agents use to drive a page.
//
// One `act` call takes many steps, so an agent can do "fill the form and submit" in a
// single round trip. Steps are flat objects (no nested unions) so that small local
// models can produce them reliably. We are lenient on input: `{click: 5}`,
// `{action: "click", target: 5}` and the DSL line `click 5` all mean the same thing.

/**
 * What to act on:
 * - a number (or "12", "[12]") — an element ref from the last observe
 * - visible text / label / placeholder / aria-label, e.g. "Sign in", "Email"
 * - "css:<selector>" for a CSS selector (also accepted when it obviously is one: "#id", ".cls", "a[href*=x]")
 * - "xy:<x>,<y>" or {x, y} — viewport coordinates (CSS pixels)
 */
export type Target = number | string | { x: number; y: number };

export const ACTIONS = [
  'click',
  'dblclick',
  'rightclick',
  'hover',
  'focus',
  'type',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'scroll',
  'goto',
  'back',
  'forward',
  'reload',
  'wait',
  'upload',
  'newtab',
  'switchtab',
  'closetab',
] as const;

export type Action = (typeof ACTIONS)[number];

export interface Step {
  action: Action;
  /** Element to act on (see Target). For `type` it may be omitted to type into the focused element. */
  target?: Target;
  /** type: the text. wait: text to wait for. */
  text?: string;
  /** select: option label/value (or several). check: desired state. */
  value?: string | string[] | boolean;
  /** fill: { "Email": "a@b.c", "Remember me": true, "12": "x" } — keys are targets. */
  fields?: Record<string, string | number | boolean>;
  /** press: "Enter", "Escape", "Tab", "ArrowDown", "Meta+A", "Control+Shift+K". */
  key?: string;
  /** goto / newtab: URL or search terms. */
  url?: string;
  /** scroll: direction (default down). */
  direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom';
  /** scroll: pixels, or screens when <= 10 (default 0.8 screen). */
  amount?: number;
  /** wait: milliseconds to sleep. */
  ms?: number;
  /** wait: CSS selector to appear. */
  selector?: string;
  /** wait: text that must disappear. */
  gone?: string;
  /** wait: substring the URL must contain. */
  urlIncludes?: string;
  /** Per-step timeout, ms. */
  timeout?: number;
  /** type/fill: press Enter afterwards. */
  submit?: boolean;
  /** type: clear the field first (default true). */
  clear?: boolean;
  /** type: send real key events per character (for widgets that ignore pasted text). */
  slowly?: boolean;
  /** press: repeat count. */
  times?: number;
  /** upload: absolute file paths. */
  files?: string[];
  /** switchtab / closetab: tab id. */
  tab?: string;
  /** click: modifier keys held during the click. */
  modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[];
}

const ACTION_SET = new Set<string>(ACTIONS);

const ALIASES: Record<string, Action> = {
  navigate: 'goto',
  open: 'goto',
  visit: 'goto',
  go: 'goto',
  input: 'type',
  enter: 'type',
  write: 'type',
  key: 'press',
  keypress: 'press',
  doubleclick: 'dblclick',
  double_click: 'dblclick',
  right_click: 'rightclick',
  contextmenu: 'rightclick',
  tap: 'click',
  choose: 'select',
  sleep: 'wait',
  new_tab: 'newtab',
  switch_tab: 'switchtab',
  close_tab: 'closetab',
  refresh: 'reload',
  mouseover: 'hover',
};

function canonicalAction(a: string): Action | null {
  const k = a.trim().toLowerCase();
  if (ACTION_SET.has(k)) return k as Action;
  return ALIASES[k] ?? null;
}

/**
 * Accepts the many shapes LLMs produce and returns a clean Step.
 * Throws an Error with a helpful message when the step can't be understood.
 */
export function normalizeStep(raw: unknown): Step {
  if (typeof raw === 'string') {
    const parsed = parseScript(raw);
    if (parsed.length !== 1) throw new Error(`Expected one step, got ${parsed.length}: ${raw}`);
    return parsed[0];
  }
  if (!raw || typeof raw !== 'object') throw new Error(`Step must be an object, got ${JSON.stringify(raw)}`);
  const o = { ...(raw as Record<string, unknown>) };

  let action: Action | null = null;
  if (typeof o.action === 'string') action = canonicalAction(o.action);
  else if (typeof o.type === 'string' && canonicalAction(o.type) && (o.type !== 'type' || o.text !== undefined)) {
    // {type: "click", target: 3} style: `type` used as the action name
    action = canonicalAction(o.type);
    delete o.type;
  }
  if (!action) {
    // {click: 5} / {goto: "url"} / {type: "hello", into: 3}
    for (const key of Object.keys(o)) {
      const a = canonicalAction(key);
      if (!a) continue;
      action = a;
      const v = o[key];
      delete o[key];
      if (a === 'goto' || a === 'newtab') o.url ??= v;
      else if (a === 'type') o.text ??= v;
      else if (a === 'press') o.key ??= v;
      else if (a === 'fill' && v && typeof v === 'object') o.fields ??= v;
      else if (a === 'wait') {
        if (typeof v === 'number') o.ms ??= v;
        else if (typeof v === 'string') o.text ??= v;
        else if (v && typeof v === 'object') Object.assign(o, v);
      } else if (a === 'scroll') {
        if (typeof v === 'string' && ['up', 'down', 'left', 'right', 'top', 'bottom'].includes(v)) o.direction ??= v;
        else if (v !== true) o.target ??= v;
      } else if (a === 'switchtab' || a === 'closetab') o.tab ??= v;
      else if (v !== true && v !== null && v !== undefined) o.target ??= v;
      break;
    }
  }
  if (!action) throw new Error(`Unknown step ${JSON.stringify(raw)}. Use {"action": one of ${ACTIONS.join(', ')}}`);

  // Common synonyms for fields.
  o.target ??= o.into ?? o.element ?? o.ref ?? o.selector_or_text ?? o.on;
  if (o.target === undefined && typeof o.selector === 'string' && action !== 'wait') o.target = `css:${o.selector}`;
  if (action === 'type' && o.text === undefined) o.text = (o.value as string) ?? (o.content as string);
  if (action === 'press' && o.key === undefined) o.key = (o.keys as string) ?? (o.text as string);
  if ((action === 'goto' || action === 'newtab') && o.url === undefined) o.url = (o.href as string) ?? (o.text as string);
  if (action === 'select' && o.value === undefined) o.value = (o.option as string) ?? (o.text as string);
  if (action === 'fill' && !o.fields && o.values && typeof o.values === 'object') o.fields = o.values;
  if (typeof o.target === 'string' && /^\[?\d+\]?$/.test(o.target.trim())) o.target = Number(o.target.replace(/[[\]]/g, ''));

  const step: Step = { action };
  const keys: (keyof Step)[] = [
    'target', 'text', 'value', 'fields', 'key', 'url', 'direction', 'amount', 'ms', 'selector', 'gone',
    'urlIncludes', 'timeout', 'submit', 'clear', 'slowly', 'times', 'files', 'tab', 'modifiers',
  ];
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) (step as any)[k] = o[k];

  if (['click', 'dblclick', 'rightclick', 'hover', 'focus', 'select', 'check', 'uncheck', 'upload'].includes(action) && step.target === undefined)
    throw new Error(`"${action}" needs a target (ref number, visible text, or css:selector)`);
  if (action === 'type' && typeof step.text !== 'string') {
    if (typeof step.text === 'number') step.text = String(step.text);
    else throw new Error('"type" needs text');
  }
  if (action === 'press' && !step.key) throw new Error('"press" needs a key, e.g. "Enter"');
  if (action === 'goto' && !step.url) throw new Error('"goto" needs a url');
  if (action === 'fill' && (!step.fields || typeof step.fields !== 'object')) throw new Error('"fill" needs fields: {"Label": "value"}');
  return step;
}

export function normalizeSteps(raw: unknown): Step[] {
  if (typeof raw === 'string') return parseScript(raw);
  if (!Array.isArray(raw)) return [normalizeStep(raw)];
  return raw.map(normalizeStep);
}

// ---------- DSL ----------
//
//   click "Sign in"; type "Email" "me@x.com"; type "Password" "hunter2" enter
//   press Enter            press Tab 3
//   goto github.com        newtab news.ycombinator.com
//   wait "Dashboard"       wait 500       wait gone "Loading"     wait url "/dashboard"
//   scroll down | scroll down 3 | scroll "Pricing"
//   select "Country" "Portugal"
//   check "Remember me"
//   fill "Email"="a@b.c" Name=Ada "Subscribe"=true
//   upload "Resume" /path/to/cv.pdf
//
// Steps are separated by newlines or `;` (outside quotes). Bare numbers are refs.
// Unquoted multi-word targets are joined: `click Sign in` == `click "Sign in"`.

interface Tok {
  /** Text with quotes removed. */
  text: string;
  /** The whole token was one quoted string. */
  quoted: boolean;
  /** Index in `text` of the first `=` that was outside quotes (for fill pairs), or -1. */
  eq: number;
}

const OPEN_QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’' };

function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let text = '';
    let eq = -1;
    let segments = 0;
    let allQuoted = true;
    while (i < line.length && !/\s/.test(line[i])) {
      const close = OPEN_QUOTES[line[i]];
      segments++;
      if (close) {
        i++;
        while (i < line.length && line[i] !== close) {
          if (line[i] === '\\' && i + 1 < line.length) {
            i++;
            text += line[i] === 'n' ? '\n' : line[i];
          } else text += line[i];
          i++;
        }
        i++; // closing quote
      } else {
        allQuoted = false;
        while (i < line.length && !/\s/.test(line[i]) && !OPEN_QUOTES[line[i]]) {
          if (line[i] === '=' && eq < 0) eq = text.length;
          text += line[i++];
        }
      }
    }
    out.push({ text, quoted: allQuoted && segments === 1, eq });
  }
  return out;
}

function splitSteps(script: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let close: string | null = null;
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (close) {
      if (c === '\\') {
        cur += c + (script[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === close) close = null;
      cur += c;
      continue;
    }
    if (OPEN_QUOTES[c]) {
      close = OPEN_QUOTES[c];
      cur += c;
      continue;
    }
    if (c === ';' || c === '\n') {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter((p) => !p.startsWith('#') && !p.startsWith('//'));
}

function toTarget(t: Tok): Target {
  if (!t.quoted && /^\[?\d+\]?$/.test(t.text)) return Number(t.text.replace(/[[\]]/g, ''));
  return t.text;
}

/** Joins unquoted words into one target: `click Sign in` → "Sign in". */
function joinTarget(toks: Tok[]): Target {
  if (toks.length === 1) return toTarget(toks[0]);
  return toks.map((t) => t.text).join(' ');
}

const FLAG_WORDS = new Set(['enter', 'submit', 'slowly', 'append']);

export function parseScript(script: string): Step[] {
  const steps: Step[] = [];
  for (const line of splitSteps(script)) {
    const toks = tokenize(line);
    if (!toks.length) continue;
    const action = canonicalAction(toks[0].text);
    if (!action) throw new Error(`Unknown command "${toks[0].text}" in: ${line}. Commands: ${ACTIONS.join(', ')}`);
    let args = toks.slice(1);
    const flags = new Set<string>();
    if (action === 'type' || action === 'fill') {
      // trailing flag words (unquoted)
      while (args.length && !args[args.length - 1].quoted && FLAG_WORDS.has(args[args.length - 1].text.toLowerCase())) {
        flags.add(args.pop()!.text.toLowerCase());
      }
    }
    const step: Step = { action };
    const need = (n: number, what: string) => {
      if (args.length < n) throw new Error(`${action} needs ${what}: ${line}`);
    };
    switch (action) {
      case 'type': {
        need(1, 'text');
        if (args.length >= 2) {
          step.target = args.length === 2 ? toTarget(args[0]) : joinTarget(args.slice(0, -1));
          step.text = args[args.length - 1].text;
        } else step.text = args[0].text;
        if (flags.has('enter') || flags.has('submit')) step.submit = true;
        if (flags.has('slowly')) step.slowly = true;
        if (flags.has('append')) step.clear = false;
        break;
      }
      case 'fill': {
        need(1, '"Label"="value" pairs');
        const fields: Record<string, string | boolean> = {};
        for (const a of args) {
          if (a.eq < 0) throw new Error(`fill expects "Label"="value" pairs, got ${a.text}: ${line}`);
          const k = a.text.slice(0, a.eq);
          const v = a.text.slice(a.eq + 1);
          fields[k] = v === 'true' ? true : v === 'false' ? false : v;
        }
        step.fields = fields;
        if (flags.has('enter') || flags.has('submit')) step.submit = true;
        break;
      }
      case 'select':
        need(2, 'a target and an option');
        step.target = toTarget(args[0]);
        step.value = args.length > 2 ? args.slice(1).map((a) => a.text) : args[1].text;
        break;
      case 'press':
        need(1, 'a key, e.g. Enter');
        step.key = args[0].text;
        if (args[1] && /^\d+$/.test(args[1].text)) step.times = Number(args[1].text);
        break;
      case 'scroll': {
        const a = args[0];
        if (!a) step.direction = 'down';
        else if (!a.quoted && ['up', 'down', 'left', 'right', 'top', 'bottom'].includes(a.text.toLowerCase())) {
          step.direction = a.text.toLowerCase() as Step['direction'];
          if (args[1]) step.amount = Number(args[1].text);
        } else if (!a.quoted && /^\d+(\.\d+)?$/.test(a.text)) {
          step.direction = 'down';
          step.amount = Number(a.text);
        } else step.target = joinTarget(args);
        break;
      }
      case 'goto':
      case 'newtab':
        if (args.length) step.url = args.map((a) => a.text).join(' ');
        else if (action === 'goto') throw new Error(`goto needs a url: ${line}`);
        break;
      case 'wait': {
        const a = args[0];
        if (!a) {
          step.ms = 1000;
          break;
        }
        const w = a.text.toLowerCase();
        if (!a.quoted && w === 'gone' && args[1]) step.gone = args.slice(1).map((x) => x.text).join(' ');
        else if (!a.quoted && w === 'url' && args[1]) step.urlIncludes = args[1].text;
        else if (!a.quoted && (w === 'css' || w === 'selector') && args[1]) step.selector = args.slice(1).map((x) => x.text).join(' ');
        else if (!a.quoted && /^\d+$/.test(w)) step.ms = Number(w);
        else if (!a.quoted && /^\d+(\.\d+)?s$/.test(w)) step.ms = Number(w.slice(0, -1)) * 1000;
        else step.text = args.map((x) => x.text).join(' ');
        break;
      }
      case 'upload':
        need(2, 'a target and file paths');
        step.target = toTarget(args[0]);
        step.files = args.slice(1).map((a) => a.text);
        break;
      case 'check':
      case 'uncheck':
      case 'click':
      case 'dblclick':
      case 'rightclick':
      case 'hover':
      case 'focus':
        need(1, 'a target (ref number, text, or css:selector)');
        step.target = joinTarget(args);
        break;
      case 'switchtab':
      case 'closetab':
        if (args[0]) step.tab = args[0].text;
        break;
      case 'back':
      case 'forward':
      case 'reload':
        break;
    }
    steps.push(step);
  }
  return steps;
}

/** Short human label for a step, used in the UI and logs: 'Click “Sign in”'. */
export function describeStep(s: Step): string {
  const t = (x: Target | undefined) =>
    x === undefined ? '' : typeof x === 'number' ? `[${x}]` : typeof x === 'string' ? `“${x.replace(/^(css|text):/, '')}”` : `(${x.x}, ${x.y})`;
  switch (s.action) {
    case 'click':
      return `Click ${t(s.target)}`;
    case 'dblclick':
      return `Double-click ${t(s.target)}`;
    case 'rightclick':
      return `Right-click ${t(s.target)}`;
    case 'hover':
      return `Hover ${t(s.target)}`;
    case 'focus':
      return `Focus ${t(s.target)}`;
    case 'type':
      return `Type ${s.target !== undefined ? `into ${t(s.target)}` : ''}`.trim();
    case 'fill':
      return `Fill ${Object.keys(s.fields ?? {}).map((k) => `“${k}”`).join(', ')}`;
    case 'select':
      return `Select “${Array.isArray(s.value) ? s.value.join(', ') : s.value}” in ${t(s.target)}`;
    case 'check':
      return `Check ${t(s.target)}`;
    case 'uncheck':
      return `Uncheck ${t(s.target)}`;
    case 'press':
      return `Press ${s.key}${s.times && s.times > 1 ? ` ×${s.times}` : ''}`;
    case 'scroll':
      return s.target !== undefined ? `Scroll to ${t(s.target)}` : `Scroll ${s.direction ?? 'down'}`;
    case 'goto':
      return `Open ${s.url}`;
    case 'newtab':
      return `New tab ${s.url ?? ''}`.trim();
    case 'back':
      return 'Go back';
    case 'forward':
      return 'Go forward';
    case 'reload':
      return 'Reload';
    case 'wait':
      return s.text ? `Wait for “${s.text}”` : s.gone ? `Wait until “${s.gone}” is gone` : s.selector ? `Wait for ${s.selector}` : `Wait ${s.ms ?? 1000}ms`;
    case 'upload':
      return `Upload ${s.files?.length ?? 0} file(s) to ${t(s.target)}`;
    case 'switchtab':
      return `Switch to tab ${s.tab}`;
    case 'closetab':
      return `Close tab ${s.tab ?? ''}`.trim();
  }
}
