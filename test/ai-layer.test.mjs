// Tests for src/main/ai: the agent loop against a mock OpenAI-compatible server, text-encoded tool
// calls, AI search with and without a model, search fallbacks, the organizer and small helpers.
//   node --test test/ai-layer.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(os.tmpdir(), `clickless-ai-test-${process.pid}.cjs`);
let ai;

before(async () => {
  await build({
    stdin: {
      contents: `
        export { createAI } from './src/main/ai/index';
        export { summarizeCall, compactHistory, repairThread } from './src/main/ai/agent';
        export { splitRelated } from './src/main/ai/ask';
        export { heuristicProposal, sanitizeProposal, siteKey } from './src/main/ai/organize';
        export { providerLabel, claudeName } from './src/main/ai/providers';
        export { parseTextToolCalls, extractJson, coerceArgs, validateArgs } from './src/main/ai/util';
        export { toOpenAIMessages } from './src/main/ai/providers/openai';
      `,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    external: ['electron'],
    logLevel: 'error',
  });
  ai = createRequire(import.meta.url)(out);
});

// ---------- fakes ----------

const ACT_SCHEMA = {
  type: 'object',
  properties: {
    steps: { type: 'array', items: { type: 'object' } },
    script: { type: 'string' },
    tab: { type: 'string' },
  },
};

function fakeDeps({ providers = [], agentProviderId = null, headless = {}, tools } = {}) {
  const calls = [];
  const chats = [];
  const asks = [];
  const tab = { id: 't1', spaceId: 's1', url: 'https://example.com/login', title: 'Login', pinned: false, favorite: false, order: 0, lastActiveAt: 1, internal: false };
  const settings = {
    searchEngine: 'google',
    askBackend: 'duckduckgo',
    askReadPages: 2,
    providers,
    agentProviderId,
    askProviderId: null,
    control: { enabled: true, port: 7734, cdpPort: null },
    agent: { maxSteps: 5, showCursor: true, cursorMs: 0, dialogs: 'accept' },
    tabs: { archiveAfterHours: 12, sleepAfterMinutes: 30 },
    appearance: { theme: 'system', compactUrl: false },
  };
  const toolDefs = tools ?? [
    {
      name: 'act',
      description: 'Run steps',
      inputSchema: ACT_SCHEMA,
      handler: async (args) => {
        calls.push(args);
        return { text: 'Clicked “Sign in”\nURL: https://example.com/home\nTitle: Home\nmore\nlines' };
      },
    },
  ];
  const activity = [];
  const browser = {
    listTabs: () => [tab],
    activeTab: () => tab,
    getTab: (id) => (id === tab.id ? tab : null),
    beginActivity: (source, label) => {
      activity.push({ source, label, ended: false });
      const a = activity[activity.length - 1];
      return () => (a.ended = true);
    },
    assertNotPaused: () => {},
    settings: () => settings,
    headless: {
      evaluate: headless.evaluate ?? (async () => []),
      read: headless.read ?? (async (url) => ({ url, title: 'Page', markdown: `Content of ${url}` })),
    },
  };
  const deps = {
    browser,
    tools: {
      list: () => toolDefs,
      get: (n) => toolDefs.find((t) => t.name === n),
      call: (n, args, ctx) => toolDefs.find((t) => t.name === n).handler(args, ctx),
      instructions: 'Use act with many steps.',
    },
    settings: () => settings,
    getSecret: () => undefined,
    control: () => null,
    emitChat: (s) => chats.push(s),
    emitAsk: (s) => asks.push(s),
    openAskPage: () => {},
  };
  return { deps, calls, chats, asks, activity, settings };
}

/** Mock /v1/chat/completions. `script(body, n)` returns {sse: [chunks]} or {json: body}. */
async function mockServer(script) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-b' }, { id: 'mock-a' }] }));
    }
    const body = JSON.parse(raw || '{}');
    requests.push({ headers: req.headers, body });
    const reply = script(body, requests.length);
    if (reply.json) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(reply.json));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of reply.sse) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      await new Promise((r) => setTimeout(r, 2));
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

const delta = (d, finish = null) => ({ model: 'mock', choices: [{ index: 0, delta: d, finish_reason: finish }] });

function provider(url, extra = {}) {
  return { id: 'p1', kind: 'openai', label: 'Mock', baseURL: url, model: 'mock', hasKey: false, vision: false, ...extra };
}

// ---------- agent ----------

test('agent.run executes a streamed tool call and finishes with the answer', async () => {
  const srv = await mockServer((body) => {
    const hasTool = body.messages.some((m) => m.role === 'tool');
    if (!hasTool)
      return {
        sse: [
          delta({ role: 'assistant', content: '' }),
          delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'act', arguments: '' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '{"steps":[{"action":"cli' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: 'ck","target":"Sign in"}]}' } }] }),
          delta({}, 'tool_calls'),
        ],
      };
    return { sse: [delta({ content: 'Done: ' }), delta({ content: 'clicked Sign in.' }), delta({}, 'stop')] };
  });
  try {
    const { deps, calls, activity } = fakeDeps({ providers: [provider(srv.url)] });
    const AI = ai.createAI(deps);
    const res = await AI.agent.run('Sign me in');
    assert.equal(res.text, 'Done: clicked Sign in.');
    assert.equal(res.steps, 1);
    assert.deepEqual(calls, [{ steps: [{ action: 'click', target: 'Sign in' }] }]);
    // Second request carries the tool result; no Authorization header without a key.
    const second = srv.requests[1].body.messages;
    assert.ok(second.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1' && m.content.includes('Clicked')));
    assert.equal(srv.requests[0].headers.authorization, undefined);
    assert.ok(srv.requests[0].body.tools.some((t) => t.function.name === 'act'));
    assert.ok(srv.requests[0].body.messages[0].content.includes('Use act with many steps.'), 'tool guide in system prompt');
    assert.ok(activity.every((a) => a.ended), 'activity ended');
  } finally {
    await srv.close();
  }
});

test('agent panel thread: user, tool row and streamed answer in ChatState', async () => {
  const srv = await mockServer((body) => {
    const hasTool = body.messages.some((m) => m.role === 'tool');
    if (!hasTool)
      return {
        sse: [
          delta({ content: 'Let me sign in.' }),
          delta({ tool_calls: [{ index: 0, id: 'c9', function: { name: 'act', arguments: '{"script":"click \\"Sign in\\"; type \\"Email\\" \\"a@b.c\\"; press Enter"}' } }] }),
          delta({}, 'tool_calls'),
        ],
      };
    return { sse: [delta({ content: 'Signed in.' }), delta({}, 'stop')] };
  });
  try {
    const { deps, chats } = fakeDeps({ providers: [provider(srv.url)] });
    const AI = ai.createAI(deps);
    AI.agent.send('log in please');
    for (let i = 0; i < 200 && (AI.agent.state().running || !AI.agent.state().items.some((x) => x.kind === 'assistant' && x.text === 'Signed in.')); i++)
      await new Promise((r) => setTimeout(r, 10));
    const st = AI.agent.state();
    assert.equal(st.running, false);
    const kinds = st.items.map((i) => i.kind);
    assert.deepEqual(kinds, ['user', 'assistant', 'tool', 'assistant']);
    const tool = st.items[2];
    assert.equal(tool.status, 'done');
    assert.equal(tool.summary, 'Click “Sign in”, Type into “Email”, Press Enter');
    assert.equal(tool.result.split('\n').length, 3);
    assert.equal(st.providerLabel, 'mock · Mock');
    assert.ok(chats.length > 0);
    // Second turn reuses the thread (history now has 4 messages + new user).
    AI.agent.reset();
    assert.equal(AI.agent.state().items.length, 0);
  } finally {
    await srv.close();
  }
});

test('text-encoded tool calls from a non-streaming server are executed', async () => {
  const srv = await mockServer((body) => {
    const hasTool = body.messages.some((m) => m.role === 'tool');
    const content = hasTool ? '<think>ok</think>All done.' : '<tool_call>{"name": "act", "arguments": {"script": "click 3"}}</tool_call>';
    return { json: { model: 'mock', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] } };
  });
  try {
    const { deps, calls } = fakeDeps({ providers: [provider(srv.url)] });
    const res = await ai.createAI(deps).agent.run('click three');
    assert.deepEqual(calls, [{ script: 'click 3' }]);
    assert.equal(res.text, 'All done.');
  } finally {
    await srv.close();
  }
});

test('invalid tool arguments are not run and go back to the model as an error', async () => {
  let sawError = '';
  const srv = await mockServer((body) => {
    const tool = body.messages.find((m) => m.role === 'tool');
    if (!tool) return { sse: [delta({ tool_calls: [{ index: 0, id: 'x', function: { name: 'act', arguments: '{"steps": 5' } }] }), delta({}, 'tool_calls')] };
    sawError = tool.content;
    return { sse: [delta({ content: 'ok' }), delta({}, 'stop')] };
  });
  try {
    const { deps, calls } = fakeDeps({ providers: [provider(srv.url)] });
    await ai.createAI(deps).agent.run('x');
    assert.equal(calls.length, 0);
    assert.match(sawError, /INVALID_ARGUMENTS/);
  } finally {
    await srv.close();
  }
});

test('no provider: a notice, never a throw', async () => {
  const { deps } = fakeDeps();
  const AI = ai.createAI(deps);
  AI.agent.send('hello');
  await new Promise((r) => setTimeout(r, 20));
  const st = AI.agent.state();
  assert.equal(st.items[1].kind, 'notice');
  assert.match(st.items[1].text, /Settings → AI/);
  assert.equal(st.providerLabel, null);
});

test('stop aborts a running task cleanly', async () => {
  const srv = await mockServer(() => ({ sse: Array.from({ length: 300 }, () => delta({ content: 'x' })) }));
  try {
    const { deps } = fakeDeps({ providers: [provider(srv.url)] });
    const AI = ai.createAI(deps);
    AI.agent.send('write a lot');
    await new Promise((r) => setTimeout(r, 60));
    AI.agent.stop();
    for (let i = 0; i < 100 && AI.agent.state().running; i++) await new Promise((r) => setTimeout(r, 10));
    const st = AI.agent.state();
    assert.equal(st.running, false);
    assert.ok(st.items.some((i) => i.kind === 'notice' && i.text === 'Stopped.'));
  } finally {
    await srv.close();
  }
});

// ---------- search & ask ----------

const ddgResults = [
  { title: 'Result A', url: 'https://a.example/x', snippet: 'About A' },
  { title: 'Result B', url: 'https://b.example/y', snippet: 'About B' },
  { title: 'Dup A', url: 'https://a.example/x#frag', snippet: '' },
];

test('search falls back to the next backend and reads the top results', async () => {
  const tried = [];
  const { deps } = fakeDeps({
    headless: {
      evaluate: async (url) => {
        tried.push(new URL(url).hostname);
        if (url.includes('duckduckgo')) throw new Error('blocked');
        return ddgResults;
      },
    },
  });
  const res = await ai.createAI(deps).search('test query', { read: 2 });
  assert.deepEqual(tried, ['html.duckduckgo.com', 'search.brave.com']);
  assert.equal(res.results.length, 2, 'deduped');
  assert.equal(res.pages.length, 2);
  assert.equal(res.pages[0].n, 1);
});

test('ask without a model shows sources and how to add one', async () => {
  const { deps, asks } = fakeDeps({ headless: { evaluate: async () => ddgResults } });
  const AI = ai.createAI(deps);
  const id = AI.ask.start('what is clickless');
  for (let i = 0; i < 100 && AI.ask.state(id).turns[0].status !== 'done'; i++) await new Promise((r) => setTimeout(r, 10));
  const st = AI.ask.state(id);
  assert.equal(st.turns[0].status, 'done');
  assert.equal(st.turns[0].sources.length, 2);
  assert.ok(st.turns[0].sources.every((s) => s.read));
  assert.match(st.turns[0].answer, /Settings → AI/);
  assert.ok(asks.length > 0);
});

test('ask streams a cited answer and parses related questions', async () => {
  const srv = await mockServer((body) => {
    assert.match(body.messages[body.messages.length - 1].content, /\[1\] Result A/);
    return { sse: [delta({ content: 'Clickless is a browser [1].' }), delta({ content: '\n\nRelated: Is it free? | Does it run Ollama? | How do I install it?' }), delta({}, 'stop')] };
  });
  try {
    const { deps } = fakeDeps({ providers: [provider(srv.url)], headless: { evaluate: async () => ddgResults } });
    const AI = ai.createAI(deps);
    const id = AI.ask.start('what is clickless');
    for (let i = 0; i < 200 && AI.ask.state(id).turns[0].status !== 'done'; i++) await new Promise((r) => setTimeout(r, 10));
    const st = AI.ask.state(id);
    assert.equal(st.turns[0].answer, 'Clickless is a browser [1].');
    assert.deepEqual(st.related, ['Is it free?', 'Does it run Ollama?', 'How do I install it?']);
    // Follow-up carries the previous Q/A.
    AI.ask.followup(id, 'is it free?');
    for (let i = 0; i < 200 && AI.ask.state(id).turns[1]?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 10));
    const last = srv.requests[srv.requests.length - 1].body.messages;
    assert.ok(last.some((m) => m.role === 'assistant' && m.content === 'Clickless is a browser [1].'));
  } finally {
    await srv.close();
  }
});

// ---------- organizer ----------

const T = (id, url, extra = {}) => ({ id, spaceId: 's1', url, title: `Title ${id}`, pinned: false, favorite: false, order: Number(id.slice(1)), lastActiveAt: Number(id.slice(1)), internal: false, ...extra });

test('heuristic organizer groups by site and closes duplicates', () => {
  const tabs = [
    T('t1', 'https://github.com/a/b'),
    T('t2', 'https://github.com/c/d'),
    T('t3', 'https://www.youtube.com/watch?v=1'),
    T('t4', 'https://youtube.com/watch?v=2'),
    T('t5', 'https://github.com/a/b'),
    T('t6', 'https://news.bbc.co.uk/x'),
  ];
  const p = ai.heuristicProposal('s1', tabs);
  assert.equal(p.source, 'heuristic');
  assert.deepEqual(p.close, ['t1']); // t5 is newer
  assert.deepEqual(
    p.groups.map((g) => [g.name, g.tabIds]),
    [
      ['GitHub', ['t2', 't5']],
      ['YouTube', ['t3', 't4']],
    ],
  );
  assert.equal(ai.siteKey('https://news.bbc.co.uk/x'), 'bbc.co.uk');
});

test('AI organizer output is sanitized', () => {
  const tabs = [T('t1', 'https://a.com'), T('t2', 'https://b.com'), T('t3', 'https://c.com')];
  const p = ai.sanitizeProposal(
    's1',
    tabs,
    { groups: [{ name: 'Research', emoji: '🧪', tabIds: ['t1', 't2', 'bogus'] }, { name: 'Solo', tabIds: ['t3'] }, { name: 'Again', tabIds: ['t1', 't3'] }], renames: [{ tabId: 't3', title: 'C' }, { tabId: 'nope', title: 'x' }] },
    [],
  );
  assert.deepEqual(p.groups, [{ name: 'Research', emoji: '🧪', tabIds: ['t1', 't2'] }]);
  assert.deepEqual(p.renames, [{ tabId: 't3', title: 'C' }]);
  assert.equal(p.source, 'ai');
});

// ---------- helpers ----------

test('summaries, labels and helpers', () => {
  assert.equal(ai.summarizeCall('act', { steps: [{ click: 'Sign in' }, { action: 'goto', url: 'github.com' }] }), 'Click “Sign in”, Open github.com');
  assert.equal(ai.summarizeCall('search', { query: 'electron', read: 3 }), 'Search “electron” and read 3 results');
  assert.equal(ai.claudeName('claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(ai.claudeName('anthropic/claude-sonnet-5-5'), 'Claude Sonnet 5.5');
  assert.equal(ai.claudeName('claude-opus-4-5-20251101'), 'Claude Opus 4.5');
  assert.equal(ai.claudeName('claude-opus-5'), 'Claude Opus 5');
  assert.equal(ai.providerLabel({ kind: 'anthropic', label: 'Anthropic', model: 'claude-opus-5-5' }), 'Claude Opus 5.5 · Anthropic');
  assert.equal(ai.providerLabel({ kind: 'openai', label: 'Ollama', model: 'qwen3:14b' }), 'qwen3:14b · Ollama');
  assert.equal(ai.providerLabel({ kind: 'claude-code', label: 'Claude Code', model: 'default' }), 'Claude Code');
  assert.deepEqual(ai.splitRelated('Answer [1].\n\n**Related:** A? | B? | C?'), { answer: 'Answer [1].', related: ['A?', 'B?', 'C?'] });
  assert.deepEqual(ai.extractJson('Sure:\n```json\n{"a": [1, {"b": "}"}]}\n```'), { a: [1, { b: '}' }] });
  assert.deepEqual(ai.coerceArgs(ACT_SCHEMA, { steps: '[{"click": 1}]' }), { steps: [{ click: 1 }] });
  assert.equal(ai.validateArgs({ type: 'object', required: ['q'], properties: { q: { type: 'string' } } }, {}), 'missing required argument "q"');
  const parsed = ai.parseTextToolCalls('```json\n{"name":"search","arguments":{"query":"x"}}\n```', ['search']);
  assert.deepEqual(parsed.calls, [{ name: 'search', args: { query: 'x' } }]);
});

test('compactHistory shrinks older tool results and keeps the newest image', () => {
  const long = 'x'.repeat(2000);
  const img = { data: 'AAAA', mimeType: 'image/png' };
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', text: '', toolCalls: [{ id: 'a', name: 'act', args: {} }] },
    { role: 'tool', results: [{ id: 'a', name: 'act', text: long, images: [img] }] },
    { role: 'assistant', text: '', toolCalls: [{ id: 'b', name: 'act', args: {} }] },
    { role: 'tool', results: [{ id: 'b', name: 'act', text: long, images: [img] }] },
  ];
  const c = ai.compactHistory(msgs, true);
  assert.ok(c[2].results[0].text.length < 700);
  assert.equal(c[2].results[0].images, undefined);
  assert.equal(c[4].results[0].text.length, 2000);
  assert.equal(c[4].results[0].images.length, 1);
  // OpenAI conversion puts images in a user message after the tool message (vision on).
  const oa = ai.toOpenAIMessages('sys', c, true);
  assert.equal(oa[oa.length - 1].role, 'user');
  assert.equal(oa[oa.length - 2].role, 'tool');
});

test('listModels and testProvider against an OpenAI-compatible server', async () => {
  const srv = await mockServer(() => ({ sse: [delta({ content: 'OK' }), delta({}, 'stop')] }));
  try {
    const { deps } = fakeDeps({ providers: [provider(srv.url)] });
    const AI = ai.createAI(deps);
    assert.deepEqual(await AI.listModels('p1'), ['mock-a', 'mock-b']);
    const t = await AI.testProvider('p1');
    assert.equal(t.ok, true);
    assert.match(t.message, /replied “OK”/);
    const bad = await AI.testProvider('nope');
    assert.equal(bad.ok, false);
  } finally {
    await srv.close();
  }
});

// ---------- Anthropic provider (mock server via baseURL) ----------

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

test('Anthropic: streamed thinking + tool_use, history replayed unchanged, request shape', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    requests.push({ headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const start = { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } };
    if (requests.length === 1) {
      res.end(
        sse([
          start,
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'act', input: {} } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"steps":[{"click":' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Sign in"}]}' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
          { type: 'message_stop' },
        ]),
      );
    } else {
      res.end(
        sse([
          start,
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Signed in.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ]),
      );
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = { id: 'a1', kind: 'anthropic', label: 'Anthropic', baseURL: url, model: 'claude-opus-5-5', hasKey: true, vision: true, effort: 'medium' };
    const { deps, calls } = fakeDeps({ providers: [cfg] });
    deps.getSecret = () => 'sk-test';
    const res = await ai.createAI(deps).agent.run('sign in');
    assert.equal(res.text, 'Signed in.');
    assert.deepEqual(calls, [{ steps: [{ click: 'Sign in' }] }]);
    const first = requests[0].body;
    assert.equal(first.model, 'claude-opus-5-5');
    assert.deepEqual(first.thinking, { type: 'adaptive' });
    assert.deepEqual(first.output_config, { effort: 'medium' });
    assert.deepEqual(first.cache_control, { type: 'ephemeral' });
    assert.equal(first.tools[0].eager_input_streaming, true);
    assert.equal(first.fallbacks, undefined, 'no fallbacks through a non-first-party base URL');
    // SDK 1.x sends the key as a bearer token.
    assert.ok(requests[0].headers['x-api-key'] === 'sk-test' || requests[0].headers.authorization === 'Bearer sk-test');
    const second = requests[1].body.messages;
    assert.equal(second[1].role, 'assistant');
    assert.equal(second[1].content[0].type, 'thinking');
    assert.equal(second[1].content[0].signature, 'sig123');
    assert.equal(second[2].content[0].type, 'tool_result');
    assert.equal(second[2].content[0].tool_use_id, 'toolu_1');
  } finally {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
  }
});

after(async () => {
  const { rmSync } = await import('node:fs');
  rmSync(out, { force: true });
});
