// Agent profiles: an agent that connects over MCP (Claude Code, Codex, Gemini CLI, Cursor…) gets
// its own browser — a separate Clickless process with its own profile folder (cookies, logins,
// history, tabs) and its own window — instead of acting in yours. Its tool calls are forwarded to
// that process. It can ask for your tabs (request_tabs); you pick which, and copies open in its
// window. Per agent, Settings can switch it to your profile instead ("shared").

import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentClient, type AgentClientId } from '../shared/agents';
import type { AgentProfileStatus, Settings } from '../shared/types';
import type { Clickless } from './browser';
import type { ToolDef, ToolResult } from './contracts';
import { dataDir } from './store';

type Access = 'own' | 'shared';
interface Instance {
  id: AgentClientId | string;
  name: string;
  proc?: ChildProcess;
  url?: string;
  token?: string;
  pid?: number;
  starting?: Promise<Instance>;
  lastUsedAt: number;
  calls: number;
  tabs?: number;
}

/** Clients that are the user's own scripts act in the user's profile unless set otherwise. */
const OWN_BY_DEFAULT = (id: string) => !['http', 'cli', 'clickless'].includes(id);

export const REQUEST_TABS_TOOL: Omit<ToolDef, 'handler'> = {
  name: 'request_tabs',
  description:
    'Ask the user to share tabs from their own browser with you. You work in your own browser profile and window; the user’s tabs, logins and history are private to them. Use this when you need a page the user has open (say why in `reason`). They choose which tabs to share; copies open in your window (your profile is not signed in as them). Returns the new tab ids, or an error if they decline or don’t answer.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'One sentence shown to the user: why you need their tabs.' },
      match: { type: 'string', description: 'Optional: a site or words to pre-select matching tabs (e.g. "github.com" or "invoice").' },
    },
    required: ['reason'],
  },
  readOnly: true,
};

export class AgentProfiles {
  private instances = new Map<string, Instance>();
  private pending = new Map<string, { resolve(ids: string[] | null): void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;

  constructor(private b: Clickless) {
    app.on('before-quit', () => this.stopAll());
  }

  private get cfg(): Settings['agents'] {
    return this.b.state.settings.agents;
  }

  /** The profile id for a client name: its known id (claude-code, codex…), or one derived from its name. */
  idFor(client: string): string {
    const info = agentClient(client);
    return info.id === 'mcp' ? `mcp-${client.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'client'}` : info.id;
  }

  /** Where a client's tool calls go: its own profile, or the user's. */
  access(client: string): Access {
    const id = this.idFor(client);
    return this.cfg.access[id] ?? (OWN_BY_DEFAULT(agentClient(client).id) ? this.cfg.defaultAccess : 'shared');
  }

  setAccess(clientId: string, access: Access | null) {
    const next = { ...this.cfg.access };
    if (access) next[clientId] = access;
    else delete next[clientId];
    this.b.state.settings = { ...this.b.state.settings, agents: { ...this.cfg, access: next } };
    this.b.save();
    this.b.pushState();
  }

  dirOf(id: string) {
    return path.join(dataDir(), 'agent-profiles', id.replace(/[^a-z0-9-]/gi, '_'));
  }

  status(): AgentProfileStatus[] {
    const ids = new Set<string>([...this.instances.keys(), ...this.knownProfiles()]);
    return [...ids].map((id) => {
      const i = this.instances.get(id);
      const info = agentClient(id);
      return { id, name: i?.name ?? info.name, running: !!i?.url && !!i.pid, lastUsedAt: i?.lastUsedAt ?? 0, calls: i?.calls ?? 0, tabs: i?.tabs, access: this.cfg.access[id] ?? (OWN_BY_DEFAULT(info.id) ? this.cfg.defaultAccess : 'shared') };
    });
  }

  private knownProfiles(): string[] {
    try {
      return fs.readdirSync(path.join(dataDir(), 'agent-profiles')).filter((d) => fs.existsSync(path.join(dataDir(), 'agent-profiles', d, 'state.json')));
    } catch {
      return [];
    }
  }

  private readDiscovery(id: string): { url: string; token: string; pid: number } | null {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(this.dirOf(id), 'home', 'control.json'), 'utf8'));
      try {
        process.kill(d.pid, 0);
      } catch {
        return null;
      }
      return d;
    } catch {
      return null;
    }
  }

  /** Starts (or finds) the agent's own browser. */
  async ensure(client: string): Promise<Instance> {
    const info = agentClient(client);
    const id = this.idFor(client);
    let inst = this.instances.get(id);
    if (!inst) {
      inst = { id, name: info.id === 'mcp' ? client : info.name, lastUsedAt: Date.now(), calls: 0 };
      this.instances.set(id, inst);
    }
    if (inst.url && inst.pid) {
      try {
        process.kill(inst.pid, 0);
        return inst;
      } catch {
        inst.url = inst.pid = undefined;
      }
    }
    if (inst.starting) return inst.starting;
    const found = this.readDiscovery(id);
    if (found) {
      Object.assign(inst, { url: found.url, token: found.token, pid: found.pid });
      this.b.pushState();
      return inst;
    }
    inst.starting = this.spawn(inst).finally(() => (inst!.starting = undefined));
    return inst.starting;
  }

  private async spawn(inst: Instance): Promise<Instance> {
    const dir = this.dirOf(inst.id);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.rmSync(path.join(home, 'control.json'), { force: true });
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CLICKLESS_USER_DATA: dir, CLICKLESS_HOME: home, CLICKLESS_AGENT_PROFILE: inst.id, CLICKLESS_AGENT_NAME: inst.name, CLICKLESS_PORT: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = app.isPackaged ? [] : [app.getAppPath()];
    const proc = spawn(process.execPath, args, { env, stdio: 'ignore', detached: false });
    inst.proc = proc;
    proc.on('exit', () => {
      if (inst.proc === proc) {
        inst.proc = undefined;
        inst.url = inst.pid = undefined;
        this.b.pushState();
      }
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
      const d = this.readDiscovery(inst.id);
      if (d) {
        Object.assign(inst, { url: d.url, token: d.token, pid: d.pid });
        this.b.pushState();
        return inst;
      }
      if (proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`${inst.name}'s browser didn't start.`);
  }

  private async post(inst: Instance, route: string, body: unknown, signal?: AbortSignal) {
    const r = await fetch(`${inst.url}${route}`, { method: 'POST', headers: { authorization: `Bearer ${inst.token}`, 'content-type': 'application/json', 'x-clickless-client': inst.name }, body: JSON.stringify(body ?? {}), signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && (j as any)?.error) throw new Error((j as any).error);
    return j;
  }

  /** Runs a browser tool in the agent's own browser. */
  async forward(client: string, name: string, args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
    try {
      const inst = await this.ensure(client);
      inst.lastUsedAt = Date.now();
      inst.calls++;
      const r = (await this.post(inst, `/v1/${name}`, args, signal)) as ToolResult;
      this.refreshTabs(inst);
      return r && typeof r.text === 'string' ? r : { text: JSON.stringify(r), isError: true };
    } catch (err) {
      return { text: `Clickless couldn't reach your browser profile: ${(err as Error).message}`, isError: true };
    }
  }

  private refreshTabs(inst: Instance) {
    fetch(`${inst.url}/v1/tabs?all=1`, { headers: { authorization: `Bearer ${inst.token}` } })
      .then((r) => r.json())
      .then((list) => {
        inst.tabs = Array.isArray(list) ? list.length : inst.tabs;
        this.b.pushState();
      })
      .catch(() => {});
  }

  /** request_tabs: asks the user in the main window, then opens copies of the chosen tabs in the agent's window. */
  async requestTabs(client: string, args: { reason?: string; match?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const inst = await this.ensure(client).catch((e) => e as Error);
    if (inst instanceof Error) return { text: inst.message, isError: true };
    const requestId = `share${++this.seq}`;
    const tabs = this.b.listTabs({ all: true }).filter((t: any) => /^https?:/.test(t.url));
    if (!tabs.length) return { text: 'The user has no web pages open to share.', isError: true };
    const m = String(args.match ?? '').toLowerCase().trim();
    const preselect = m ? tabs.filter((t: any) => `${t.title} ${t.url}`.toLowerCase().includes(m)).map((t: any) => t.id) : [];
    this.b.setOverlay({ kind: 'share-tabs', requestId, clientId: inst.id, clientName: inst.name, reason: String(args.reason ?? '').slice(0, 300), preselect });
    this.b.bringToFront();
    const ids = await new Promise<string[] | null>((resolve) => {
      const timer = setTimeout(() => this.resolveShare(requestId, null), 180_000);
      this.pending.set(requestId, { resolve, timer });
      signal?.addEventListener('abort', () => this.resolveShare(requestId, null));
    });
    if (!ids) return { text: 'The user didn’t share any tabs (declined or no answer). Carry on without them or ask in your reply.', isError: true };
    const chosen = tabs.filter((t: any) => ids.includes(t.id));
    const opened = (await this.post(inst, '/v1/app', { action: 'open', urls: chosen.map((t: any) => t.url) })) as { ids?: string[] };
    this.refreshTabs(inst);
    const lines = chosen.map((t: any, i: number) => `[${opened.ids?.[i] ?? '?'}] ${t.title} — ${t.url}`);
    return { text: `The user shared ${chosen.length} tab${chosen.length === 1 ? '' : 's'}; ${chosen.length === 1 ? 'it is' : 'they are'} open in your window:\n${lines.join('\n')}\nUse the ids with the tab parameter (they're copies: you aren't signed in as the user).` };
  }

  resolveShare(requestId: string, tabIds: string[] | null) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    const o = this.b.overlayKind();
    if (o?.kind === 'share-tabs' && o.requestId === requestId) this.b.setOverlay(null);
    p.resolve(tabIds && tabIds.length ? tabIds : null);
  }

  async show(id: string) {
    const inst = await this.ensure(id);
    await this.post(inst, '/v1/app', { action: 'focus' });
  }

  /** Quits the agent's browser and deletes its profile (cookies, logins, tabs). */
  async reset(id: string) {
    const inst = this.instances.get(id);
    if (inst?.url) await this.post(inst, '/v1/app', { action: 'quit' }).catch(() => {});
    inst?.proc?.kill();
    await new Promise((r) => setTimeout(r, 800));
    this.instances.delete(id);
    fs.rmSync(this.dirOf(id), { recursive: true, force: true });
    this.setAccess(id, null);
    this.b.pushState();
  }

  stopAll() {
    for (const inst of this.instances.values()) {
      if (inst.url) fetch(`${inst.url}/v1/app`, { method: 'POST', headers: { authorization: `Bearer ${inst.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'quit' }) }).catch(() => {});
      setTimeout(() => inst.proc?.kill(), 1500).unref?.();
    }
  }
}

