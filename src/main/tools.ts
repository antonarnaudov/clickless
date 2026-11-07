// The tool set every agent gets — over MCP, HTTP, the CLI and the built-in panel.
// Few tools, each doing a lot per call: that is what keeps agents from looping.

import { ACTIONS, normalizeSteps } from '../shared/steps';
import type { AI, Browser, JSONSchema, ToolContext, ToolDef, ToolRegistry, ToolResult } from './contracts';

export const INSTRUCTIONS = `Clickless is the user's own browser, signed in to their accounts. You control it with a few high-level tools; each call does a lot, so you rarely need many.

How to work fast:
- act runs MANY steps in ONE call and then reports what happened: each step's result, the new URL, text that appeared (errors, toasts), and either the changed elements or, on a new page, the full element list. Don't call observe after act — the answer is already in the act result.
- Targets can be refs from observe/act output ([12]) or just the visible text / label / placeholder ("Sign in", "Email"). You can act on a page you haven't observed if you know what's on it.
- Example: act {"steps":[{"action":"goto","url":"github.com/login"},{"action":"type","target":"Username","text":"me"},{"action":"type","target":"Password","text":"…","submit":true}]}
- Or the same as a script: act {"script":"goto github.com/login; type Username \\"me\\"; type Password \\"…\\" enter"}
- observe gives the numbered list of everything you can click or type on the current page (plus headings). Use query to filter big pages.
- read returns the page content as markdown (articles, results, tables, prices). Use query to pull out matching paragraphs.
- search does a web search AND reads the top results in one call — use it for research instead of browsing result pages by hand.
- screenshot only when visuals or layout matter; prefer observe/read (they're cheaper and exact).
- handoff when something needs the human: logging in with their password, 2FA, captchas, payments. It waits until they're done.
- tabs lists, opens, switches and closes tabs. Tools act on the active tab unless you pass tab.

Be careful: this is a real browser with real accounts. Ask the user before buying, sending messages/emails, posting, or deleting anything.`;

const str = (description: string, extra: Partial<JSONSchema> = {}): JSONSchema => ({ type: 'string', description, ...extra });
const num = (description: string, extra: Partial<JSONSchema> = {}): JSONSchema => ({ type: 'number', description, ...extra });
const bool = (description: string): JSONSchema => ({ type: 'boolean', description });

const STEP_SCHEMA: JSONSchema = {
  type: 'object',
  description: 'One step. Only "action" is required; add the fields that action uses.',
  properties: {
    action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
    target: str('Element: a ref from observe ("12"), its visible text/label/placeholder ("Sign in", "Email"), "css:<selector>", or "xy:<x>,<y>".'),
    text: str('type: text to type. wait: text to wait for.'),
    value: str('select: option label or value. check: "true"/"false".'),
    fields: { type: 'object', description: 'fill: {"Email": "a@b.c", "Password": "…", "Remember me": true} — keys are targets, values are text, an option, or true/false for checkboxes.' },
    key: str('press: a key or combo, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Meta+A".'),
    url: str('goto / newtab: URL or search terms.'),
    direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom', 'left', 'right'], description: 'scroll direction (default down).' },
    amount: num('scroll: screens (<= 10) or pixels.'),
    ms: num('wait: milliseconds to sleep.'),
    selector: str('wait: CSS selector to appear.'),
    gone: str('wait: text that must disappear.'),
    urlIncludes: str('wait: substring the URL must contain.'),
    submit: bool('type / fill: press Enter afterwards.'),
    clear: bool('type: replace the current value (default true).'),
    slowly: bool('type: send real key presses one by one (for autocomplete widgets).'),
    times: num('press: how many times.'),
    files: { type: 'array', items: { type: 'string' }, description: 'upload: absolute file paths.' },
    tab: str('switchtab / closetab: tab id.'),
    timeout: num('Max ms for this step.'),
  },
  required: ['action'],
};

function txt(text: string, isError = false): ToolResult {
  return { text, isError };
}

/** Accepts camelCase and snake_case argument names. */
function arg<T = unknown>(a: Record<string, any>, ...names: string[]): T | undefined {
  for (const n of names) {
    if (a[n] !== undefined && a[n] !== null && a[n] !== '') return a[n] as T;
    const snake = n.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    if (a[snake] !== undefined && a[snake] !== null && a[snake] !== '') return a[snake] as T;
  }
  return undefined;
}

const boolArg = (v: unknown) => v === true || v === 'true' || v === 1;

export function createTools(getAI: () => AI | null): ToolRegistry {
  const tools: ToolDef[] = [
    {
      name: 'observe',
      description:
        'List what you can interact with on the current page: every link, button, field, checkbox… with a ref number, its state and value, plus headings for structure. Call it when you arrive on a page you do not know. Elements are listed in page order with markers for what is above/below the viewport; you can act on any of them without scrolling.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          query: str('Only list elements/headings containing this text (several with |), e.g. "price|add to cart".'),
          text: bool('Also include short visible text between elements (default false; use read for content).'),
          viewportOnly: bool('Only what is visible on screen now.'),
          screenshot: bool('Attach a screenshot with numbered boxes matching the refs (for vision models).'),
          max: num('Max elements listed (default 200).'),
          tab: str('Tab id (default: the active tab).'),
        },
      },
      handler: (a, ctx) =>
        ctx.browser.observe({
          tabId: arg(a, 'tab', 'tabId'),
          query: arg(a, 'query', 'filter'),
          text: boolArg(arg(a, 'text')),
          viewportOnly: boolArg(arg(a, 'viewportOnly')),
          screenshot: boolArg(arg(a, 'screenshot')),
          max: arg<number>(a, 'max') ? Number(arg(a, 'max')) : undefined,
        }),
    },
    {
      name: 'act',
      description:
        'Do one or more steps on the page in a single call: click, type, fill a whole form, select, check, press keys, scroll, goto, back, wait, upload, open/switch/close tabs. Targets are refs ("12") or visible text/labels ("Sign in", "Email"). After the steps it waits for the page to settle and returns each step\'s result plus what changed (new URL, new text such as errors, changed elements, or the full element list on a new page) — so you usually don\'t need observe afterwards. Stops at the first failing step and tells you why, with similar elements.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: STEP_SCHEMA, description: 'Steps in order, e.g. [{"action":"type","target":"Search","text":"usb-c hub","submit":true}]' },
          script: str('Alternative to steps, one per line or separated by ";": click "Sign in"; type "Email" "me@x.com"; press Enter; goto example.com; wait "Welcome"; scroll down; select "Country" "Portugal"; check "I agree"; fill "Name"="Ann" "City"="Lisbon"'),
          observe: { type: 'string', enum: ['auto', 'always', 'never'], description: 'Element list after the steps: auto (changes, or the full list on a new page), always, never.' },
          screenshot: bool('Attach a screenshot after the steps.'),
          continueOnError: bool('Run the remaining steps even if one fails.'),
          tab: str('Tab id (default: the active tab).'),
        },
      },
      handler: async (a, ctx) => {
        const raw = arg(a, 'steps') ?? arg(a, 'script') ?? arg(a, 'actions') ?? (a.action ? [a] : undefined);
        if (raw === undefined) return txt('Give steps (array) or script (string).', true);
        let steps;
        try {
          steps = normalizeSteps(typeof raw === 'string' && raw.trim().startsWith('[') ? JSON.parse(raw) : raw);
        } catch (err) {
          return txt(`Could not understand the steps: ${(err as Error).message}`, true);
        }
        return ctx.browser.act(steps, {
          tabId: arg(a, 'tab', 'tabId'),
          observe: arg(a, 'observe'),
          screenshot: boolArg(arg(a, 'screenshot')),
          continueOnError: boolArg(arg(a, 'continueOnError')),
          signal: ctx.signal,
          source: ctx.source,
        });
      },
    },
    {
      name: 'read',
      description:
        'Read the page as clean markdown: the main article/content by default, or everything with mode "full". Use query to get only matching paragraphs (several terms with |, or /regex/). Long pages are paginated with offset/limit.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['article', 'full'], description: 'article = main content (default), full = all visible text including navigation.' },
          query: str('Only paragraphs matching this.'),
          offset: num('Start character for long pages.'),
          limit: num('Max characters (default 12000).'),
          links: bool('Keep link URLs in the markdown (off by default to save tokens; use observe to click links).'),
          tab: str('Tab id (default: the active tab).'),
        },
      },
      handler: (a, ctx) =>
        ctx.browser.read({
          tabId: arg(a, 'tab', 'tabId'),
          mode: arg(a, 'mode'),
          query: arg(a, 'query'),
          offset: arg(a, 'offset') !== undefined ? Number(arg(a, 'offset')) : undefined,
          limit: arg(a, 'limit') !== undefined ? Number(arg(a, 'limit')) : undefined,
          links: boolArg(arg(a, 'links')),
        }),
    },
    {
      name: 'search',
      description:
        'Search the web through the browser (no API key) and read the top results in the same call. Returns numbered results with titles, URLs and snippets, plus the readable text of the first `read` pages. Use it for research instead of clicking through search pages.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          query: str('What to search for.'),
          read: num('How many top results to read in full (0–6, default 3).'),
          limit: num('How many results to list (default 8).'),
        },
        required: ['query'],
      },
      handler: async (a, ctx) => {
        const ai = getAI();
        const query = String(arg(a, 'query', 'q') ?? '').trim();
        if (!query) return txt('Give a query.', true);
        if (!ai) return txt('Search is not available yet.', true);
        const readN = Math.max(0, Math.min(6, Number(arg(a, 'read') ?? 3)));
        const r = await ai.search(query, { limit: Number(arg(a, 'limit') ?? 8), read: readN, signal: ctx.signal });
        if (!r.results.length) return txt(`No results for “${query}”.`, true);
        const lines = [`Results for “${query}”:`];
        r.results.forEach((x, i) => lines.push(`[${i + 1}] ${x.title}\n    ${x.url}\n    ${x.snippet}`));
        for (const p of r.pages) {
          const body = p.markdown.length > 6000 ? p.markdown.slice(0, 6000) + '\n…(truncated; open the page and use read for more)' : p.markdown;
          lines.push('', `── [${p.n}] ${p.title} — ${p.url} ──`, body);
        }
        return { text: lines.join('\n'), data: r };
      },
    },
    {
      name: 'tabs',
      description:
        'Manage tabs: list (default), open a URL (or search terms), switch to a tab, close one, pin/unpin. Tab ids look like "t12". Listing shows every tab of the current space with its id, title and URL; the active one is marked.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'open', 'switch', 'close', 'pin', 'unpin'], description: 'Default list.' },
          url: str('open: URL or search terms.'),
          tab: str('switch / close / pin / unpin: tab id.'),
          background: bool('open: keep the current tab in front.'),
          all: bool('list: include every space.'),
        },
      },
      handler: async (a, ctx) => {
        const b = ctx.browser;
        const action = String(arg(a, 'action') ?? 'list');
        const tab = arg<string>(a, 'tab', 'tabId', 'id');
        switch (action) {
          case 'open': {
            const url = String(arg(a, 'url') ?? '');
            b.assertNotPaused();
            const t = await b.openTab(url || 'clickless://newtab', { background: boolArg(arg(a, 'background')), source: ctx.source });
            return txt(`Opened tab ${t.id}: ${t.url}${boolArg(arg(a, 'background')) ? ' (in the background)' : ''}. Use act/observe/read on it${boolArg(arg(a, 'background')) ? ` with tab "${t.id}"` : ''}.`);
          }
          case 'switch':
            if (!tab || !b.getTab(tab)) return txt(`No tab “${tab}”.`, true);
            b.activateTab(tab);
            return txt(`Switched to ${tab}: ${b.getTab(tab)?.title}`);
          case 'close':
            if (!tab || !b.getTab(tab)) return txt(`No tab “${tab}”.`, true);
            b.closeTab(tab);
            return txt(`Closed ${tab}.`);
          case 'pin':
          case 'unpin':
            return txt('Pinning is done from the sidebar for now.', true);
          default: {
            const active = b.activeTab();
            const list = b.listTabs({ all: boolArg(arg(a, 'all')) });
            const lines = list
              .sort((x, y) => Number(y.favorite) - Number(x.favorite) || Number(y.pinned) - Number(x.pinned) || x.order - y.order)
              .map((t) => `${t.id === active?.id ? '▶' : ' '} ${t.id}  ${t.favorite ? '★ ' : t.pinned ? '📌 ' : ''}${t.title.slice(0, 80)} — ${t.url}${t.asleep ? ' (asleep)' : ''}`);
            return { text: lines.length ? lines.join('\n') : 'No tabs open.', data: list };
          }
        }
      },
    },
    {
      name: 'screenshot',
      description: 'Take a screenshot of the visible page (or the full page, or one element). With marks, interactive elements get numbered boxes that match observe refs. Use only when visuals matter — observe/read are cheaper and exact.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          marks: bool('Draw numbered boxes on interactive elements.'),
          fullPage: bool('Capture the whole page, not just the viewport.'),
          target: str('Only this element (ref or text).'),
          tab: str('Tab id (default: the active tab).'),
        },
      },
      handler: (a, ctx) =>
        ctx.browser.screenshot({
          tabId: arg(a, 'tab', 'tabId'),
          marks: boolArg(arg(a, 'marks')),
          fullPage: boolArg(arg(a, 'fullPage')),
          target: arg(a, 'target'),
        }),
    },
    {
      name: 'evaluate',
      description: 'Run JavaScript in the page (it sees the page\'s own variables) and return the result as JSON. An escape hatch for data extraction the other tools can\'t do; prefer read/observe.',
      inputSchema: {
        type: 'object',
        properties: {
          code: str('An expression, statements (the last value is returned), or a function like "() => [...document.querySelectorAll(\'h2\')].map(h => h.textContent)". Promises are awaited.'),
          tab: str('Tab id (default: the active tab).'),
        },
        required: ['code'],
      },
      handler: (a, ctx) => ctx.browser.evaluate(String(arg(a, 'code', 'js', 'script') ?? ''), { tabId: arg(a, 'tab', 'tabId') }),
    },
    {
      name: 'handoff',
      description:
        'Ask the human to do something only they should do in the visible browser — sign in with their password, 2FA, a captcha, a payment confirmation — then continue. Shows your message above the page and waits until they press Done (up to 10 minutes). Returns the page state afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          message: str('What you need, in one short sentence, e.g. "Please sign in to GitHub, then press Done."'),
          tab: str('Tab id (default: the active tab).'),
          timeoutSeconds: num('How long to wait (default 600).'),
        },
        required: ['message'],
      },
      handler: (a, ctx) =>
        ctx.browser.handoff(String(arg(a, 'message', 'text') ?? 'Please help with this page, then press Done.'), {
          tabId: arg(a, 'tab', 'tabId'),
          timeoutMs: arg(a, 'timeoutSeconds') ? Number(arg(a, 'timeoutSeconds')) * 1000 : undefined,
        }),
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));
  // common aliases models reach for
  const aliases: Record<string, string> = {
    snapshot: 'observe', look: 'observe', page: 'observe', click: 'act', type: 'act', navigate: 'act', goto: 'act',
    get_text: 'read', extract: 'read', web_search: 'search', tab: 'tabs', screen: 'screenshot', eval: 'evaluate', ask_human: 'handoff',
    browser_observe: 'observe', browser_act: 'act', browser_read: 'read', browser_search: 'search', browser_tabs: 'tabs',
  };

  return {
    instructions: INSTRUCTIONS,
    list: () => tools,
    get: (name) => byName.get(name) ?? byName.get(aliases[name] ?? '') ?? byName.get(name.replace(/^(mcp__[\w-]+__|clickless[_.])/, '')),
    async call(name: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const tool = this.get(name);
      if (!tool) return txt(`Unknown tool “${name}”. Tools: ${tools.map((t) => t.name).join(', ')}`, true);
      let a = args ?? {};
      if (typeof a === 'string') {
        try {
          a = JSON.parse(a);
        } catch {
          a = tool.name === 'act' ? { script: a } : tool.name === 'search' ? { query: a } : {};
        }
      }
      // shorthand: calling "click"/"goto" directly as tools
      if (tool.name === 'act' && name !== 'act' && !a.steps && !a.script) a = { steps: [{ action: aliases[name] ? name : 'click', ...a }] };
      try {
        if (!tool.readOnly) ctx.browser.assertNotPaused();
        return await tool.handler(a, ctx);
      } catch (err) {
        const msg = (err as Error).message || String(err);
        return txt(`${tool.name} failed: ${msg}`, true);
      }
    },
  };
}

/** Tool schemas in the formats other ecosystems expect. */
export function exportTools(reg: ToolRegistry, format: 'openai' | 'anthropic' | 'mcp' | 'json' = 'json') {
  const list = reg.list();
  switch (format) {
    case 'openai':
      return list.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    case 'anthropic':
      return list.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    case 'mcp':
      return list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !!t.readOnly } }));
    default:
      return list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, readOnly: !!t.readOnly }));
  }
}
