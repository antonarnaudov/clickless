// In-memory stand-in for the main process, so the UI can be built and screenshotted in a plain
// browser (`npm run ui:dev`). Inside Electron `window.clickless` already exists and this is a no-op.
//
//   /shell.html                 ?agent=0 hides the agent glow, ?banner=1 shows a hand-off banner,
//                               ?panel=0 closes the agent panel, ?sidebar=0 hides the sidebar, ?split=1
//   /overlay.html?overlay=palette|commands|ask|settings|ai|agents|organize|space
//   /internal.html?page=newtab|ask

import type { ClicklessAPI, Command, QueryMap, QueryName, ShellEvent } from '../shared/ipc';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { AskState, ChatItem, ChatState, OverlayState, Settings, Suggestion, Tab, UIState } from '../shared/types';

// Only on the Vite dev server (http:). Inside Electron the UI loads from file:// and clickless://,
// so a broken preload shows up as an error instead of silently showing fake data.
if (!('clickless' in window) && location.protocol.startsWith('http')) installMock();

function installMock() {
  const params = new URLSearchParams(location.search);
  const surface: ClicklessAPI['surface'] = location.pathname.includes('overlay') ? 'overlay' : location.pathname.includes('internal') ? 'internal' : 'shell';
  const now = Date.now();
  let seq = 100;
  const id = (p: string) => `${p}${++seq}`;

  const mkTab = (t: Partial<Tab> & Pick<Tab, 'id' | 'url' | 'title'>): Tab => ({
    spaceId: 's1',
    favorite: false,
    pinned: false,
    order: 0,
    loading: false,
    canGoBack: true,
    canGoForward: false,
    audible: false,
    muted: false,
    asleep: false,
    createdAt: now - 3600_000,
    lastActiveAt: now - 600_000,
    zoom: 1,
    internal: t.url.startsWith('clickless:'),
    ...t,
  });

  const fav = (host: string) => `https://${host}/favicon.ico`;
  const tabs: Tab[] = [
    mkTab({ id: 'f1', url: 'https://mail.google.com/mail/u/0/', title: 'Inbox (3) — Gmail', favorite: true, order: 0 }),
    mkTab({ id: 'f2', url: 'https://calendar.google.com/', title: 'Google Calendar', favorite: true, order: 1 }),
    mkTab({ id: 'f3', url: 'https://github.com/', title: 'GitHub', favicon: fav('github.com'), favorite: true, order: 2 }),
    mkTab({ id: 'f4', url: 'https://www.figma.com/files', title: 'Figma', favorite: true, order: 3 }),
    mkTab({ id: 'f5', url: 'https://claude.ai/new', title: 'Claude', favorite: true, order: 4 }),
    mkTab({ id: 'p1', url: 'https://linear.app/clickless/team/CLK/active', title: 'Active issues · Clickless', pinned: true, order: 1 }),
    mkTab({ id: 'p2', url: 'https://dashboard.stripe.com/test/payments', title: 'Payments – Stripe (test)', pinned: true, folderId: 'fo1', order: 0 }),
    mkTab({ id: 'p3', url: 'https://www.producthunt.com/', title: 'Product Hunt — launch day', pinned: true, folderId: 'fo1', order: 1, asleep: true }),
    mkTab({ id: 'p4', url: 'https://www.notion.so/Spec', title: 'Clickless spec', pinned: true, order: 3 }),
    mkTab({ id: 't1', url: 'https://www.electronjs.org/docs/latest/api/web-contents-view', title: 'WebContentsView | Electron', favicon: fav('www.electronjs.org'), order: 0, lastActiveAt: now }),
    mkTab({ id: 't2', url: 'https://modelcontextprotocol.io/specification/2025-06-18', title: 'Specification — Model Context Protocol', order: 1 }),
    mkTab({ id: 't3', url: 'https://news.ycombinator.com/', title: 'Hacker News', favicon: fav('news.ycombinator.com'), order: 2, loading: true }),
    mkTab({ id: 't4', url: 'https://www.youtube.com/watch?v=dQw4', title: 'Lo-fi beats to ship to', order: 3, audible: true }),
    mkTab({ id: 't5', url: 'https://www.perplexity.ai/comet', title: 'Comet browser', folderId: 'fo2', order: 0 }),
    mkTab({ id: 't6', url: 'https://browseros.com', title: 'BrowserOS — the open-source agentic browser', folderId: 'fo2', order: 1 }),
    mkTab({ id: 't7', url: 'clickless://ask?id=mock-ask', title: 'Cheapest direct flight NYC → LON', order: 5 }),
    mkTab({ id: 'u1', url: 'https://www.airbnb.com/s/Lisbon', title: 'Lisbon · Stays · Airbnb', spaceId: 's2', order: 0 }),
    mkTab({ id: 'u2', url: 'https://open.spotify.com/', title: 'Spotify – Web Player', spaceId: 's2', order: 1, pinned: true }),
    mkTab({ id: 'u3', url: 'https://www.bbc.com/news', title: 'BBC News', spaceId: 's2', order: 2 }),
  ];

  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  settings.providers = [
    { id: 'pv1', kind: 'anthropic', label: 'Anthropic', model: 'claude-opus-5-5', effort: 'medium', vision: true, hasKey: true },
    { id: 'pv2', kind: 'openai', label: 'Ollama', baseURL: 'http://localhost:11434/v1', model: 'qwen3:14b', vision: false, hasKey: false },
  ];
  settings.agentProviderId = 'pv1';
  settings.askProviderId = 'pv1';

  const overlayParam = params.get('overlay');
  const overlayFor = (o: string | null): OverlayState | null => {
    switch (o) {
      case 'palette':
        return { kind: 'palette', mode: 'new-tab' };
      case 'navigate':
        return { kind: 'palette', mode: 'navigate', initial: 'electronjs.org/docs/latest/api/web-contents-view', tabId: 't1' };
      case 'commands':
        return { kind: 'palette', mode: 'commands' };
      case 'ask':
        return { kind: 'palette', mode: 'ask', initial: 'How do agents control a browser?' };
      case 'settings':
        return { kind: 'settings', section: 'general' };
      case 'ai':
        return { kind: 'settings', section: 'ai' };
      case 'agents':
        return { kind: 'settings', section: 'agents' };
      case 'organize':
        return { kind: 'organize', spaceId: 's1', loading: false, proposal: organizeProposal() };
      case 'space':
        return { kind: 'space' };
      default:
        return null;
    }
  };

  function organizeProposal() {
    return {
      spaceId: 's1',
      source: 'ai' as const,
      groups: [
        { name: 'Browser internals', emoji: '🧩', tabIds: ['t1', 't2'] },
        { name: 'Competitors', emoji: '🔭', tabIds: ['t5', 't6'] },
        { name: 'Break', emoji: '🎧', tabIds: ['t4', 't3'] },
      ],
      close: ['t3'],
      renames: [{ tabId: 't2', title: 'MCP spec' }],
    };
  }

  let state: UIState = {
    spaces: [
      { id: 's1', name: 'Work', icon: '🛠️', color: '#7c5cff' },
      { id: 's2', name: 'Personal', icon: '🌿', color: '#2bb5a0' },
      { id: 's3', name: 'Research', icon: '🔭', color: '#f5a524' },
    ],
    activeSpaceId: 's1',
    tabs,
    folders: [
      { id: 'fo1', spaceId: 's1', name: 'Launch week', collapsed: false, pinned: true, order: 2 },
      { id: 'fo2', spaceId: 's1', name: 'Competitors', collapsed: false, pinned: false, order: 4 },
    ],
    activeTabId: surface === 'internal' ? 't7' : 't1',
    split: params.get('split') === '1' ? { tabIds: ['t1', 't2'], ratio: 0.5 } : null,
    sidebar: { visible: params.get('sidebar') !== '0', width: 248 },
    panel: { open: params.get('panel') !== '0', width: 360 },
    overlay: overlayFor(overlayParam),
    find: params.get('find') === '1' ? { query: 'WebContents', activeMatch: 2, matches: 14 } : null,
    banners:
      params.get('banner') === '1'
        ? [
            {
              id: 'b1',
              kind: 'handoff',
              tabId: 't1',
              title: 'claude-code needs you: sign in to GitHub',
              detail: 'Log in with your account, then press Done so the agent can continue.',
              actions: [
                { label: 'Done', value: 'done' },
                { label: 'Cancel', value: 'cancel' },
              ],
              createdAt: now,
            },
            {
              id: 'b2',
              kind: 'permission',
              tabId: 't1',
              title: 'meet.google.com wants to use your camera',
              actions: [
                { label: 'Allow', value: 'allow' },
                { label: 'Block', value: 'deny' },
              ],
              createdAt: now,
            },
          ]
        : [],
    downloads: [
      { id: 'd1', filename: 'clickless-0.1.0-arm64.dmg', path: '/Users/me/Downloads/clickless-0.1.0-arm64.dmg', url: 'https://example.com', receivedBytes: 61_000_000, totalBytes: 98_000_000, state: 'progressing', startedAt: now - 20_000 },
      { id: 'd2', filename: 'invoice-2026-11.pdf', path: '/Users/me/Downloads/invoice-2026-11.pdf', url: 'https://example.com', receivedBytes: 230_000, totalBytes: 230_000, state: 'completed', startedAt: now - 3600_000 },
    ],
    agent: {
      active: params.get('agent') !== '0',
      source: 'claude-code',
      tabId: 't1',
      label: 'Click “Sign in”',
      paused: false,
      clients: [
        { name: 'claude-code', lastSeenAt: now - 4000, calls: 14 },
        { name: 'cursor', lastSeenAt: now - 600_000, calls: 3 },
      ],
    },
    settings,
    control: {
      running: true,
      port: 7734,
      url: 'http://127.0.0.1:7734',
      mcpUrl: 'http://127.0.0.1:7734/mcp',
      cdpPort: null,
      discoveryFile: '~/.clickless/control.json',
    },
    platform: 'darwin',
    fullscreen: false,
  };

  // ---------- chat ----------
  const chatItems: ChatItem[] = [
    { id: 'c1', kind: 'user', text: 'Find the cheapest direct flight from Berlin to London next Friday and open it.', at: now - 90_000 },
    { id: 'c2', kind: 'tool', name: 'search', summary: 'search “Berlin to London direct flights Nov 14”, read 3', status: 'done', result: '1. Google Flights — BER → LHR, LGW, STN…\n2. Skyscanner — Cheap flights from Berlin to London\n3. easyJet — Berlin → London Luton from €39', at: now - 85_000, ms: 2140 },
    { id: 'c3', kind: 'tool', name: 'act', summary: 'goto skyscanner.net · fill “From”, “To”, “Depart” · click “Search”', status: 'done', result: '✓ 4 steps · navigated to skyscanner.net/transport/flights/sof/lond/261114\n+ 38 results · cheapest €42 easyJet 06:10 → 07:55', at: now - 70_000, ms: 6830 },
    { id: 'c4', kind: 'tool', name: 'act', summary: 'click “Direct flights only” · click “Cheapest”', status: 'done', result: '✓ 2 steps · list re-sorted', at: now - 50_000, ms: 1210 },
    { id: 'c5', kind: 'tool', name: 'observe', summary: 'query “€”', status: 'running', at: now - 4000 },
    {
      id: 'c6',
      kind: 'assistant',
      text: 'The cheapest **direct** option on Friday 14 Nov is **easyJet U2 8648**, Berlin 06:10 → London Luton 07:55, **€42** (hand luggage only).\n\n| Airline | Time | Airport | Price |\n|---|---|---|---|\n| easyJet | 06:10 → 07:55 | LTN | €42 |\n| Ryanair | 13:40 → 15:20 | STN | €57 |\n| British Airways | 10:05 → 11:45 | LHR | €138 |\n\nI opened the easyJet offer in a new tab — [see it on Skyscanner](https://www.skyscanner.net). Want me to add a checked bag and compare totals?',
      at: now - 2000,
    },
  ];
  let chat: ChatState = { items: chatItems, running: false, providerLabel: 'Claude Opus 5.5 · Anthropic', steps: 4, maxSteps: 40 };

  // ---------- ask ----------
  const answer =
    'Agents drive a browser in three layers: they **observe** the page, **act** on it, and **check** what changed [1][3].\n\n' +
    '### Observe\nMost tools give the model a compact list of interactive elements with stable numbers (refs) instead of raw HTML, which keeps each step small enough for local models too [2]. Screenshots with numbered marks (set-of-marks) help vision models when the DOM is ambiguous [4].\n\n' +
    '### Act\nActions are sent as **trusted input events** through the DevTools protocol, so sites can’t tell them apart from a person [1]. Batching several actions per call is the biggest speed-up: “fill the form and submit” becomes one round trip instead of six [5].\n\n' +
    '### Check\nAfter acting, good tools return what changed — new URL, new text such as error messages, elements that appeared — so the agent doesn’t need another snapshot [3][5].\n\n' +
    '- Comet and Atlas keep the agent inside the browser UI\n- BrowserOS and Playwright MCP expose it to outside agents over MCP [2]';
  const askSources = [
    { n: 1, title: 'Chrome DevTools Protocol — Input domain', url: 'https://chromedevtools.github.io/devtools-protocol/tot/Input/', snippet: 'Dispatches a mouse event to the page…', read: true },
    { n: 2, title: 'Playwright MCP: browser automation for LLMs', url: 'https://github.com/microsoft/playwright-mcp', snippet: 'Uses the accessibility tree, not pixels…', read: true },
    { n: 3, title: 'How browser agents work — a field guide', url: 'https://simonwillison.net/2025/browser-agents/', snippet: 'Observe, act, verify…', read: true },
    { n: 4, title: 'Set-of-Mark prompting unleashes GPT-4V', url: 'https://arxiv.org/abs/2310.11441', snippet: 'Overlaying marks on image regions…', read: false },
    { n: 5, title: 'Fewer round trips: designing agent tools', url: 'https://www.anthropic.com/engineering/writing-tools-for-agents', snippet: 'Consolidate functionality…', read: true },
  ];
  let ask: AskState = {
    id: 'mock-ask',
    providerLabel: 'Claude Opus 5.5 · Anthropic',
    related: ['How does set-of-marks prompting work?', 'Is CDP input detectable by websites?', 'Which local models are good at tool calling?'],
    turns: [{ query: 'How do AI agents control a web browser?', status: 'searching', sources: [], answer: '', startedAt: now }],
  };

  // ---------- plumbing ----------
  const listeners = { state: new Set<(s: UIState) => void>(), chat: new Set<(c: ChatState) => void>(), ask: new Set<(a: AskState) => void>(), event: new Set<(e: ShellEvent) => void>() };
  const clone = <T,>(v: T): T => structuredClone(v);
  const pushState = () => {
    const s = clone(state);
    queueMicrotask(() => listeners.state.forEach((l) => l(s)));
  };
  const pushChat = () => {
    const c = clone(chat);
    listeners.chat.forEach((l) => l(c));
  };
  const pushAsk = () => {
    const a = clone(ask);
    listeners.ask.forEach((l) => l(a));
  };
  const set = (patch: Partial<UIState>) => {
    state = { ...state, ...patch };
    pushState();
  };
  const patchTab = (tabId: string, p: Partial<Tab>) => set({ tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...p } : t)) });

  // Simulated streaming of the AI search answer.
  function streamAsk(turnIdx: number, text: string) {
    const turn = () => ask.turns[turnIdx];
    setTimeout(() => {
      turn().status = 'reading';
      turn().sources = askSources;
      pushAsk();
    }, 700);
    setTimeout(() => {
      turn().status = 'answering';
      pushAsk();
      let i = 0;
      const iv = setInterval(() => {
        i += 9 + Math.floor(Math.random() * 14);
        turn().answer = text.slice(0, i);
        if (i >= text.length) {
          clearInterval(iv);
          turn().status = 'done';
          turn().ms = 4820;
        }
        pushAsk();
      }, 40);
    }, 1600);
  }
  if (surface === 'internal') streamAsk(0, answer);

  function simulateAgent(text: string) {
    chat.items.push({ id: id('c'), kind: 'user', text, at: Date.now() });
    chat.running = true;
    chat.steps = 0;
    pushChat();
    const toolId = id('c');
    setTimeout(() => {
      chat.items.push({ id: toolId, kind: 'tool', name: 'read', summary: 'mode article', status: 'running', at: Date.now() });
      chat.steps = 1;
      state.agent = { ...state.agent, active: true, source: 'Clickless agent', label: 'Reading the page' };
      pushState();
      pushChat();
    }, 400);
    setTimeout(() => {
      const t = chat.items.find((x) => x.id === toolId);
      if (t && t.kind === 'tool') {
        t.status = 'done';
        t.ms = 830;
        t.result = '# WebContentsView\nA View that displays a WebContents…\n(6,240 chars)';
      }
      const aid = id('c');
      chat.items.push({ id: aid, kind: 'assistant', text: '', at: Date.now(), streaming: true });
      pushChat();
      const reply = 'This page documents **WebContentsView**, the view class that replaced `BrowserView`:\n\n- Create it with `new WebContentsView()` and add it via `win.contentView.addChildView(view)`\n- Position it with `view.setBounds({ x, y, width, height })`\n- Rounded corners: `view.setBorderRadius(10)`';
      let i = 0;
      const iv = setInterval(() => {
        i += 6;
        const a = chat.items.find((x) => x.id === aid);
        if (a && a.kind === 'assistant') a.text = reply.slice(0, i);
        if (i >= reply.length) {
          clearInterval(iv);
          if (a && a.kind === 'assistant') a.streaming = false;
          chat.running = false;
          state.agent = { ...state.agent, active: false, label: null };
          pushState();
        }
        pushChat();
      }, 30);
    }, 1400);
  }

  function moveTab(c: Extract<Command, { type: 'tab.move' }>) {
    const t = state.tabs.find((x) => x.id === c.tabId);
    if (!t) return;
    const next: Tab = { ...t };
    if (c.spaceId) next.spaceId = c.spaceId;
    if (c.favorite !== undefined) next.favorite = c.favorite;
    if (c.pinned !== undefined) next.pinned = c.pinned;
    if (c.folderId !== undefined) next.folderId = c.folderId ?? undefined;
    if (c.favorite) next.folderId = undefined;
    // Re-number the target list.
    const sameList = (x: Tab) =>
      x.id !== t.id &&
      (next.favorite
        ? x.favorite
        : !x.favorite && x.spaceId === next.spaceId && (next.folderId ? x.folderId === next.folderId : !x.folderId && x.pinned === next.pinned));
    const list = state.tabs.filter(sameList).sort((a, b) => a.order - b.order);
    const items: { id: string; order: number; isFolder?: boolean }[] = [...list];
    if (!next.favorite && !next.folderId) {
      for (const f of state.folders) if (f.spaceId === next.spaceId && f.pinned === next.pinned) items.push({ id: f.id, order: f.order, isFolder: true });
      items.sort((a, b) => a.order - b.order);
    }
    let idx = c.beforeId ? items.findIndex((x) => x.id === c.beforeId) : -1;
    if (idx < 0) idx = items.length;
    items.splice(idx, 0, next);
    const orders = new Map(items.map((x, i) => [x.id, i]));
    set({
      tabs: state.tabs.map((x) => (x.id === t.id ? { ...next, order: orders.get(x.id)! } : orders.has(x.id) ? { ...x, order: orders.get(x.id)! } : x)),
      folders: state.folders.map((f) => (orders.has(f.id) ? { ...f, order: orders.get(f.id)! } : f)),
    });
  }

  function handle(c: Command): unknown {
    switch (c.type) {
      case 'tab.activate': {
        const t = state.tabs.find((x) => x.id === c.tabId);
        set({ activeTabId: c.tabId, activeSpaceId: t && !t.favorite ? t.spaceId : state.activeSpaceId, tabs: state.tabs.map((x) => (x.id === c.tabId ? { ...x, asleep: false, lastActiveAt: Date.now() } : x)) });
        return;
      }
      case 'tab.close': {
        const rest = state.tabs.filter((t) => t.id !== c.tabId);
        set({ tabs: rest, activeTabId: state.activeTabId === c.tabId ? (rest.find((t) => t.spaceId === state.activeSpaceId && !t.favorite)?.id ?? null) : state.activeTabId });
        return;
      }
      case 'tab.new': {
        const url = c.url ? (/^\w+:\/\//.test(c.url) ? c.url : c.url.includes('.') && !c.url.includes(' ') ? `https://${c.url}` : `https://www.google.com/search?q=${encodeURIComponent(c.url)}`) : 'clickless://newtab';
        const tid = id('t');
        const maxOrder = Math.max(0, ...state.tabs.filter((t) => t.spaceId === state.activeSpaceId).map((t) => t.order));
        const t = mkTab({ id: tid, url, title: c.url ? c.url : 'New Tab', spaceId: c.spaceId ?? state.activeSpaceId, order: maxOrder + 1, pinned: !!c.pinned, folderId: c.folderId, loading: !!c.url, lastActiveAt: Date.now() });
        set({ tabs: [...state.tabs, t], activeTabId: c.background ? state.activeTabId : tid, overlay: null });
        if (c.url) setTimeout(() => patchTab(tid, { loading: false, title: c.url! }), 900);
        return tid;
      }
      case 'tab.navigate': {
        const tid = c.tabId ?? state.activeTabId;
        if (tid) patchTab(tid, { url: /^\w+:\/\//.test(c.input) ? c.input : `https://${c.input}`, title: c.input, loading: true });
        if (tid) setTimeout(() => patchTab(tid, { loading: false }), 800);
        set({ overlay: null });
        return;
      }
      case 'tab.update':
        patchTab(c.tabId, c.patch);
        return;
      case 'tab.move':
        moveTab(c);
        return;
      case 'tab.duplicate': {
        const t = state.tabs.find((x) => x.id === c.tabId);
        if (t) set({ tabs: [...state.tabs, { ...t, id: id('t'), order: t.order + 0.5, favorite: false }] });
        return;
      }
      case 'tabs.clearToday':
        set({ tabs: state.tabs.filter((t) => t.favorite || t.pinned || t.spaceId !== (c.spaceId ?? state.activeSpaceId)) });
        return;
      case 'folder.create': {
        const fid = id('fo');
        set({
          folders: [...state.folders, { id: fid, spaceId: c.spaceId ?? state.activeSpaceId, name: c.name ?? 'New Folder', collapsed: false, pinned: c.pinned ?? true, order: 99 }],
          tabs: state.tabs.map((t) => (c.tabIds?.includes(t.id) ? { ...t, folderId: fid, pinned: c.pinned ?? true } : t)),
        });
        return fid;
      }
      case 'folder.update':
        set({ folders: state.folders.map((f) => (f.id === c.folderId ? { ...f, ...c.patch } : f)) });
        return;
      case 'folder.delete':
        set({ folders: state.folders.filter((f) => f.id !== c.folderId), tabs: c.closeTabs ? state.tabs.filter((t) => t.folderId !== c.folderId) : state.tabs.map((t) => (t.folderId === c.folderId ? { ...t, folderId: undefined } : t)) });
        return;
      case 'folder.move':
        set({ folders: state.folders.map((f) => (f.id === c.folderId ? { ...f, pinned: c.pinned ?? f.pinned, order: c.beforeId ? (state.folders.find((x) => x.id === c.beforeId)?.order ?? state.tabs.find((x) => x.id === c.beforeId)?.order ?? 99) - 0.5 : 99 } : f)) });
        return;
      case 'space.activate':
        set({ activeSpaceId: c.spaceId, activeTabId: state.tabs.find((t) => t.spaceId === c.spaceId && !t.favorite)?.id ?? null });
        return;
      case 'space.cycle': {
        const i = state.spaces.findIndex((s) => s.id === state.activeSpaceId);
        const s = state.spaces[(i + c.dir + state.spaces.length) % state.spaces.length];
        return handle({ type: 'space.activate', spaceId: s.id });
      }
      case 'space.create': {
        const sid = id('s');
        set({ spaces: [...state.spaces, { id: sid, name: c.name ?? 'Space', icon: c.icon ?? '✨', color: c.color ?? '#3b82f6' }], activeSpaceId: sid, overlay: null });
        return sid;
      }
      case 'space.update':
        set({ spaces: state.spaces.map((s) => (s.id === c.spaceId ? { ...s, ...c.patch } : s)), overlay: null });
        return;
      case 'space.delete':
        set({ spaces: state.spaces.filter((s) => s.id !== c.spaceId), activeSpaceId: state.spaces.find((s) => s.id !== c.spaceId)!.id, overlay: null });
        return;
      case 'ui.sidebar':
        set({ sidebar: { visible: c.visible ?? state.sidebar.visible, width: c.width ?? state.sidebar.width } });
        return;
      case 'ui.panel':
        set({ panel: { open: c.open ?? state.panel.open, width: c.width ?? state.panel.width } });
        return;
      case 'ui.overlay':
        set({ overlay: c.overlay });
        return;
      case 'ui.split':
        set({ split: c.tabIds ? { tabIds: c.tabIds, ratio: c.ratio ?? state.split?.ratio ?? 0.5 } : null });
        return;
      case 'ui.find':
        if (c.close) set({ find: null });
        else set({ find: { query: c.query ?? state.find?.query ?? '', matches: c.query ? 7 : 0, activeMatch: c.next ? ((state.find?.activeMatch ?? 0) % 7) + 1 : c.back ? Math.max(1, (state.find?.activeMatch ?? 2) - 1) : 1 } });
        return;
      case 'ui.viewports':
        return;
      case 'banner.respond':
        set({ banners: state.banners.filter((b) => b.id !== c.bannerId) });
        return;
      case 'download.clear':
        set({ downloads: state.downloads.filter((d) => d.state === 'progressing') });
        return;
      case 'agent.send':
        simulateAgent(c.text);
        return;
      case 'agent.stop':
        chat.running = false;
        pushChat();
        set({ agent: { ...state.agent, active: false, label: null } });
        return;
      case 'agent.reset':
        chat = { ...chat, items: [], steps: 0 };
        pushChat();
        return;
      case 'agent.pause':
        set({ agent: { ...state.agent, paused: c.paused, active: c.paused ? false : state.agent.active } });
        return;
      case 'ask.start':
        set({ overlay: null });
        return 'mock-ask';
      case 'ask.followup':
        ask.turns.push({ query: c.query, status: 'searching', sources: [], answer: '', startedAt: Date.now() });
        pushAsk();
        streamAsk(ask.turns.length - 1, answer);
        return;
      case 'organize.start':
        set({ overlay: { kind: 'organize', spaceId: c.spaceId ?? state.activeSpaceId, loading: true, proposal: null } });
        setTimeout(() => set({ overlay: { kind: 'organize', spaceId: 's1', loading: false, proposal: organizeProposal() } }), 1400);
        return;
      case 'organize.apply':
        set({ overlay: null });
        return;
      case 'settings.update': {
        const merge = (a: any, b: any): any => {
          for (const k of Object.keys(b)) a[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? merge({ ...(a[k] ?? {}) }, b[k]) : b[k];
          return a;
        };
        set({ settings: merge(clone(state.settings), c.patch) });
        return;
      }
      case 'provider.upsert': {
        const pid = c.provider.id ?? id('pv');
        const existing = state.settings.providers.find((p) => p.id === pid);
        const hasKey = c.apiKey === null ? false : c.apiKey ? true : (existing?.hasKey ?? false);
        const p = { ...c.provider, id: pid, hasKey };
        const providers = existing ? state.settings.providers.map((x) => (x.id === pid ? p : x)) : [...state.settings.providers, p];
        set({ settings: { ...state.settings, providers, agentProviderId: state.settings.agentProviderId ?? pid } });
        return pid;
      }
      case 'provider.remove':
        set({ settings: { ...state.settings, providers: state.settings.providers.filter((p) => p.id !== c.providerId) } });
        return;
      default:
        console.info('[mock] cmd', c);
        return;
    }
  }

  function suggest(input: string): Suggestion[] {
    const q = input.trim().toLowerCase();
    if (!q) {
      return state.tabs
        .filter((t) => !t.favorite)
        .slice(0, 5)
        .map((t) => ({ kind: 'tab' as const, title: t.title, subtitle: t.url, url: t.url, tabId: t.id, favicon: t.favicon }));
    }
    const out: Suggestion[] = [];
    const looksUrl = /^[\w-]+(\.[\w-]+)+/.test(q) && !q.includes(' ');
    if (looksUrl) out.push({ kind: 'url', title: input, url: `https://${input}` });
    for (const t of state.tabs) if (t.title.toLowerCase().includes(q) || t.url.includes(q)) out.push({ kind: 'tab', title: t.title, subtitle: t.url, url: t.url, tabId: t.id, favicon: t.favicon });
    out.push({ kind: 'search', title: input, subtitle: 'Google Search', url: `https://www.google.com/search?q=${encodeURIComponent(input)}` });
    out.push({ kind: 'history', title: 'Clickless — GitHub', subtitle: 'https://github.com/antonarnaudov/clickless', url: 'https://github.com/antonarnaudov/clickless' });
    out.push({ kind: 'archived', title: 'Arc vs Comet: which AI browser?', subtitle: 'archived 2d ago', archivedId: 'a1', url: 'https://example.com/arc-vs-comet' });
    out.push({ kind: 'ask', title: input, subtitle: 'Ask AI' });
    return out.slice(0, 8);
  }

  const queries: { [K in QueryName]: (args: QueryMap[K]['args']) => QueryMap[K]['result'] } = {
    state: () => clone(state),
    chatState: () => clone(chat),
    askState: () => clone(ask),
    suggest: (a) => suggest(a.input),
    archived: () => [{ id: 'a1', url: 'https://example.com/arc-vs-comet', title: 'Arc vs Comet: which AI browser?', spaceId: 's1', archivedAt: now - 2 * 86400_000 }],
    history: () => [
      { url: 'https://github.com/antonarnaudov/clickless', title: 'antonarnaudov/clickless', visitCount: 12, lastVisitAt: now - 60_000 },
      { url: 'https://www.electronjs.org/docs/latest', title: 'Electron Docs', visitCount: 30, lastVisitAt: now - 3600_000 },
      { url: 'https://news.ycombinator.com/', title: 'Hacker News', visitCount: 80, lastVisitAt: now - 7200_000 },
      { url: 'https://modelcontextprotocol.io/', title: 'Model Context Protocol', visitCount: 9, lastVisitAt: now - 86400_000 },
      { url: 'https://ollama.com/library', title: 'Ollama library', visitCount: 4, lastVisitAt: now - 2 * 86400_000 },
      { url: 'https://www.figma.com/', title: 'Figma', visitCount: 20, lastVisitAt: now - 3 * 86400_000 },
    ],
    importSources: () => [
      { id: 'arc', name: 'Arc', available: true },
      { id: 'comet', name: 'Comet', available: true },
      { id: 'chrome', name: 'Chrome', available: false },
    ],
    providerTest: () => ({ ok: true, message: 'Connected · claude-opus-5-5 replied in 812ms', ms: 812 }),
    providerModels: () => ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    controlSecrets: () => ({
      token: 'clickless_demo_token_not_real',
      mcpUrl: 'http://127.0.0.1:7734/mcp',
      httpUrl: 'http://127.0.0.1:7734',
      claudeCodeCommand: 'claude mcp add --transport http clickless http://127.0.0.1:7734/mcp --header "Authorization: Bearer clickless_demo…"',
      mcpJson: '{\n  "mcpServers": {\n    "clickless": { "command": "clickless", "args": ["mcp"] }\n  }\n}',
      curlExample: 'curl -s http://127.0.0.1:7734/v1/tools/observe -H "Authorization: Bearer clickless_demo…" -d "{}"',
      cliExample: 'clickless act \'click "Sign in"; type "Email" "me@x.com" enter\'',
    }),
  };

  const delay = <T,>(v: T, ms = 30) => new Promise<T>((r) => setTimeout(() => r(v), ms));

  const api: ClicklessAPI = {
    surface,
    platform: 'darwin',
    cmd: (c) => delay(handle(c)),
    query: (name, args) => delay(clone((queries[name] as (a: unknown) => unknown)(args)), name === 'providerTest' ? 700 : 30) as never,
    onState: (cb) => (listeners.state.add(cb), () => listeners.state.delete(cb)),
    onChat: (cb) => (listeners.chat.add(cb), () => listeners.chat.delete(cb)),
    onAsk: (cb) => (listeners.ask.add(cb), () => listeners.ask.delete(cb)),
    onEvent: (cb) => (listeners.event.add(cb), () => listeners.event.delete(cb)),
  };
  (window as unknown as { clickless: ClicklessAPI }).clickless = api;
  (window as unknown as { __clicklessMock: unknown }).__clicklessMock = { get state() { return state; }, set, handle, emit: (e: ShellEvent) => listeners.event.forEach((l) => l(e)) };

  // Behind the transparent overlay, paint a fake page so modals can be judged in a browser.
  if (surface === 'overlay') {
    document.documentElement.style.background =
      'linear-gradient(90deg, oklch(0.9 0.05 290) 0 256px, transparent 256px), repeating-linear-gradient(0deg, #fff 0 22px, #f1f1f4 22px 23px)';
  }
}

export {};
