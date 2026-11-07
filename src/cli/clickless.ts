// clickless — drive Clickless from any shell or agent. `clickless help` lists the commands.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

interface Discovery {
  url: string;
  mcpUrl: string;
  token: string;
  pid: number;
  version: string;
  launch?: { command: string; args: string[] };
}

const DISCOVERY = path.join(os.homedir(), '.clickless', 'control.json');

function readDiscovery(): Discovery | null {
  try {
    return JSON.parse(fs.readFileSync(DISCOVERY, 'utf8')) as Discovery;
  } catch {
    return null;
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health(d: Discovery): Promise<boolean> {
  try {
    const r = await fetch(`${d.url}/v1/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function connect(launchIfNeeded = true): Promise<Discovery> {
  const env = process.env.CLICKLESS_URL && process.env.CLICKLESS_TOKEN ? { url: process.env.CLICKLESS_URL, mcpUrl: `${process.env.CLICKLESS_URL}/mcp`, token: process.env.CLICKLESS_TOKEN, pid: 0, version: '?' } : null;
  if (env) return env;
  let d = readDiscovery();
  if (d && alive(d.pid) && (await health(d))) return d;
  if (!launchIfNeeded) throw new Error('Clickless is not running.');
  const launch = d?.launch;
  if (launch) {
    process.stderr.write('Starting Clickless…\n');
    spawn(launch.command, launch.args, { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Clickless'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    throw new Error('Clickless is not running. Start the app first.');
  }
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    d = readDiscovery();
    if (d && alive(d.pid) && (await health(d))) return d;
  }
  throw new Error('Clickless did not start. Open it manually and try again.');
}

interface ToolResult {
  text: string;
  images?: { data: string; mimeType: string }[];
  isError?: boolean;
  data?: unknown;
}

async function call(d: Discovery, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const r = await fetch(`${d.url}/v1/${tool}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', 'x-clickless-client': process.env.CLICKLESS_CLIENT || 'cli' },
    body: JSON.stringify(args),
  });
  if (!r.ok && r.status !== 422) {
    const t = await r.text();
    throw new Error(`${r.status} ${t}`);
  }
  return (await r.json()) as ToolResult;
}

function parseFlags(argv: string[]): { pos: string[]; flags: Record<string, string | boolean> } {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !['marks', 'full', 'text', 'json', 'links', 'background', 'all', 'viewport'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function saveImages(r: ToolResult, out?: string) {
  if (!r.images?.length) return;
  r.images.forEach((img, i) => {
    const ext = img.mimeType === 'image/png' ? 'png' : 'jpg';
    const file = out ? (r.images!.length > 1 ? out.replace(/(\.\w+)?$/, `-${i + 1}$1`) : out) : path.join(os.tmpdir(), `clickless-${Date.now()}-${i}.${ext}`);
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
    process.stdout.write(`\n[image saved: ${file}]\n`);
  });
}

function print(r: ToolResult, json: boolean, imageOut?: string) {
  if (json) {
    process.stdout.write(JSON.stringify({ ...r, images: r.images?.map((i) => ({ mimeType: i.mimeType, bytes: Math.round((i.data.length * 3) / 4) })) }, null, 2) + '\n');
  } else process.stdout.write(r.text + '\n');
  saveImages(r, imageOut);
  if (r.isError) process.exitCode = 1;
}

const HELP = `clickless — drive Clickless from the shell (any agent that can run commands can use it)

  clickless observe [--query "price|buy"] [--text] [--viewport] [--screenshot shot.png]
  clickless act '<steps>'          e.g. 'goto github.com/login; type Username "me"; type Password "…" enter'
  clickless goto <url|search>
  clickless back | forward | reload
  clickless click <target>
  clickless type <target> <text> [--enter]
  clickless press <key>
  clickless read [--query q] [--full] [--offset n] [--links]
  clickless search "<query>" [--read 3]
  clickless tabs [list | open <url> [--background] | switch <id> | close <id>] [--all]
  clickless screenshot [out.png] [--marks] [--full]
  clickless eval '<javascript>'
  clickless handoff "<message for the human>"
  clickless agent "<task>"         run the built-in agent
  clickless tools [--format openai|anthropic|mcp]
  clickless import [arc|comet|chrome|brave|edge]   bring in spaces, pinned tabs, folders, bookmarks and open tabs
  clickless mcp                    stdio MCP server bridged to the running browser
  clickless status
  clickless setup                  how to connect Claude Code and other agents

Targets: a ref from observe (12), visible text/label ("Sign in"), css:<selector>, or xy:<x>,<y>.
Options: --tab <id> to act on a specific tab, --json for raw JSON.`;

async function mcpBridge() {
  const server = new Server({ name: 'clickless', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: await fetchInstructions() });
  let tools: unknown[] | null = null;
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const d = await connect(true);
    if (!tools) {
      const r = await fetch(`${d.url}/v1/tools?format=mcp`, { headers: { authorization: `Bearer ${d.token}` } });
      tools = (await r.json()) as unknown[];
    }
    return { tools: tools as any };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const d = await connect(true);
    try {
      const r = await call(d, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: r.text }, ...(r.images ?? []).map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))],
        isError: r.isError || undefined,
      } as any;
    } catch (err) {
      return { content: [{ type: 'text', text: `Clickless error: ${(err as Error).message}` }], isError: true } as any;
    }
  });
  await server.connect(new StdioServerTransport());
}

async function fetchInstructions(): Promise<string | undefined> {
  try {
    const d = await connect(true);
    const r = await fetch(`${d.url}/v1/instructions`, { headers: { authorization: `Bearer ${d.token}` } });
    return await r.text();
  } catch {
    return undefined;
  }
}

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const { pos, flags } = parseFlags(rest);
  const json = !!flags.json;
  const tab = typeof flags.tab === 'string' ? flags.tab : undefined;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return void process.stdout.write(HELP + '\n');
  if (cmd === 'mcp') return mcpBridge();

  const d = await connect(cmd !== 'status');
  const act = async (script: string) => print(await call(d, 'act', { script, tab }), json);

  switch (cmd) {
    case 'status': {
      const r = await fetch(`${d.url}/v1/tabs`, { headers: { authorization: `Bearer ${d.token}` } });
      const tabs = (await r.json()) as unknown[];
      process.stdout.write(`Clickless ${d.version} running (pid ${d.pid})\nHTTP ${d.url}\nMCP  ${d.mcpUrl}\n${tabs.length} tabs in this space\n`);
      return;
    }
    case 'setup':
      process.stdout.write(
        [
          'Connect an agent to Clickless:',
          '',
          'Claude Code:',
          `  claude mcp add --scope user --transport http clickless ${d.mcpUrl} --header "Authorization: Bearer ${d.token}"`,
          '',
          'Any MCP client (Claude Desktop, Cursor, Windsurf, Codex, Zed…), stdio:',
          `  {"mcpServers": {"clickless": {"command": "node", "args": ["${process.argv[1]}", "mcp"]}}}`,
          '',
          'Any MCP client, HTTP:',
          `  {"mcpServers": {"clickless": {"type": "http", "url": "${d.mcpUrl}", "headers": {"Authorization": "Bearer ${d.token}"}}}}`,
          '',
          'Your own agent loop (OpenAI-style tools, works with Ollama / LM Studio / any API):',
          `  curl -s ${d.url}/v1/tools?format=openai -H "Authorization: Bearer ${d.token}"`,
          `  curl -s ${d.url}/v1/act -H "Authorization: Bearer ${d.token}" -d '{"script":"goto example.com"}'`,
          '',
        ].join('\n'),
      );
      return;
    case 'observe':
      return print(
        await call(d, 'observe', { tab, query: flags.query, text: !!flags.text, viewportOnly: !!flags.viewport, screenshot: !!flags.screenshot }),
        json,
        typeof flags.screenshot === 'string' ? flags.screenshot : undefined,
      );
    case 'act':
    case 'do':
      if (!pos.length) throw new Error('clickless act needs steps, e.g. clickless act \'click "Sign in"\'');
      return act(pos.join('\n'));
    case 'goto':
    case 'open':
      return act(`goto ${JSON.stringify(pos.join(' '))}`);
    case 'back':
    case 'forward':
    case 'reload':
      return act(cmd);
    case 'click':
      return act(`click ${JSON.stringify(pos.join(' '))}`);
    case 'type':
      if (pos.length < 1) throw new Error('clickless type <target> <text>');
      return act(pos.length === 1 ? `type ${JSON.stringify(pos[0])}${flags.enter ? ' enter' : ''}` : `type ${JSON.stringify(pos[0])} ${JSON.stringify(pos.slice(1).join(' '))}${flags.enter ? ' enter' : ''}`);
    case 'press':
      return act(`press ${pos[0] ?? 'Enter'}`);
    case 'scroll':
      return act(`scroll ${pos.join(' ') || 'down'}`);
    case 'read':
      return print(
        await call(d, 'read', { tab, query: flags.query, mode: flags.full ? 'full' : 'article', offset: flags.offset ? Number(flags.offset) : undefined, limit: flags.limit ? Number(flags.limit) : undefined, links: !!flags.links }),
        json,
      );
    case 'search':
      return print(await call(d, 'search', { query: pos.join(' '), read: flags.read !== undefined ? Number(flags.read) : 3 }), json);
    case 'tabs': {
      const [action = 'list', arg] = pos;
      return print(await call(d, 'tabs', { action, url: action === 'open' ? arg : undefined, tab: action !== 'open' ? arg : undefined, background: !!flags.background, all: !!flags.all }), json);
    }
    case 'screenshot':
    case 'shot': {
      const r = await call(d, 'screenshot', { tab, marks: !!flags.marks, fullPage: !!flags.full });
      return print(r, json, pos[0] ?? path.join(process.cwd(), `clickless-${Date.now()}.jpg`));
    }
    case 'eval':
    case 'evaluate':
      return print(await call(d, 'evaluate', { code: pos.join(' '), tab }), json);
    case 'handoff':
      return print(await call(d, 'handoff', { message: pos.join(' '), tab }), json);
    case 'agent': {
      const r = await fetch(`${d.url}/v1/agent`, {
        method: 'POST',
        headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ task: pos.join(' '), tab }),
      });
      const j = (await r.json()) as { text?: string; error?: string; steps?: number };
      if (j.error) throw new Error(j.error);
      process.stdout.write(`${j.text}\n${j.steps !== undefined ? `\n(${j.steps} steps)\n` : ''}`);
      return;
    }
    case 'import': {
      const auth = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' };
      if (!pos[0]) {
        const r = await fetch(`${d.url}/v1/import`, { headers: auth });
        const list = (await r.json()) as { id: string; name: string; available: boolean }[];
        process.stdout.write(`Import from:\n${list.map((s) => `  clickless import ${s.id.padEnd(8)} ${s.name}${s.available ? '' : '  (not found on this Mac)'}`).join('\n')}\n`);
        return;
      }
      const r = await fetch(`${d.url}/v1/import`, { method: 'POST', headers: auth, body: JSON.stringify({ source: pos[0] }) });
      const j = (await r.json()) as any;
      if (j.error) throw new Error(j.error);
      if (json) return void process.stdout.write(JSON.stringify(j, null, 2) + '\n');
      const lines = [`Imported from ${j.source}: found ${j.found.tabs} tabs in ${j.found.folders} folders.`];
      for (const s of j.spaces) lines.push(`  ${s.name}${s.created ? ' (new space)' : ''}: ${s.tabs} tabs, ${s.folders} folders`);
      if (j.favorites) lines.push(`  Favorites: ${j.favorites}`);
      if (j.skipped) lines.push(`  Skipped ${j.skipped} already there`);
      process.stdout.write(lines.join('\n') + '\n');
      return;
    }
    case 'tools': {
      const r = await fetch(`${d.url}/v1/tools?format=${flags.format ?? 'json'}`, { headers: { authorization: `Bearer ${d.token}` } });
      process.stdout.write(JSON.stringify(await r.json(), null, 2) + '\n');
      return;
    }
    default:
      // anything else: treat the whole line as a script (clickless 'click "x"; press Enter')
      return act([cmd, ...rest].join(' '));
  }
}

main().catch((err) => {
  process.stderr.write(`clickless: ${(err as Error).message}\n`);
  process.exit(1);
});
