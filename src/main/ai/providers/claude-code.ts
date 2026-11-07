// Uses the user's local Claude Code CLI (their login: subscription or API key) as the agent.
// Claude Code drives the browser through Clickless's own MCP server, so every tool call goes through
// the same control API external agents use.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderConfig } from '../../../shared/types';
import { AbortedError, ProviderError, type ChatProvider, type ChatRequest, type ChatResponse, type Message } from './types';

export const CLAUDE_CODE_MODELS = ['default', 'opus', 'sonnet', 'haiku'];

export function findClaudeBinary(config?: ProviderConfig): string | null {
  const candidates: string[] = [];
  if (config?.binary?.trim()) candidates.push(config.binary.trim().replace(/^~(?=\/)/, os.homedir()));
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'));
  const home = os.homedir();
  candidates.push(
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global/bin/claude'),
    path.join(home, '.bun/bin/claude'),
  );
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Working directory for Claude Code runs: empty, so no project CLAUDE.md or files are in play. */
function workspace(): string {
  const dir = path.join(os.homedir(), '.clickless', 'claude-code');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

export type ClaudeCodeEvent =
  | { type: 'init'; sessionId: string; mcpOk: boolean; mcpStatus?: string }
  | { type: 'text'; delta: string }
  | { type: 'message-end' }
  | { type: 'tool-start'; id: string; name: string; input: Record<string, any> }
  | { type: 'tool-end'; id: string; text: string; image?: { data: string; mimeType: string }; isError: boolean }
  | { type: 'result'; text: string; isError: boolean; sessionId?: string; subtype?: string };

export interface RunOptions {
  config: ProviderConfig;
  prompt: string;
  args: string[];
  signal?: AbortSignal;
  onEvent(e: ClaudeCodeEvent): void;
}

/** Spawns `claude -p` with stream-json output and maps its events. Resolves with the final result. */
export function runClaude(opts: RunOptions): Promise<{ text: string; sessionId?: string; isError: boolean }> {
  const bin = findClaudeBinary(opts.config);
  if (!bin)
    return Promise.reject(
      new ProviderError('Claude Code CLI not found. Install it (npm i -g @anthropic-ai/claude-code) or set its path in Settings → AI.'),
    );
  if (opts.signal?.aborted) return Promise.reject(new AbortedError());

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...opts.args];
  const env = { ...process.env };
  // Make sure node / the CLI's helpers resolve when Clickless was started from Finder (minimal PATH).
  env.PATH = [path.dirname(bin), '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? ''].filter(Boolean).join(path.delimiter);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: workspace(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let buf = '';
    let final: { text: string; sessionId?: string; isError: boolean } | null = null;
    let sessionId: string | undefined;
    let aborted = false;
    const openTools = new Map<string, string>();

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const handle = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.session_id) sessionId = obj.session_id;
      switch (obj.type) {
        case 'system':
          if (obj.subtype === 'init') {
            const servers: any[] = Array.isArray(obj.mcp_servers) ? obj.mcp_servers : [];
            const server = servers.find((s) => s?.name === 'clickless');
            opts.onEvent({ type: 'init', sessionId: obj.session_id, mcpOk: !server || server.status === 'connected', mcpStatus: server?.status });
          }
          return;
        case 'stream_event': {
          if (obj.parent_tool_use_id) return;
          const ev = obj.event;
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) opts.onEvent({ type: 'text', delta: ev.delta.text });
          if (ev?.type === 'message_stop') opts.onEvent({ type: 'message-end' });
          return;
        }
        case 'assistant': {
          if (obj.parent_tool_use_id) return;
          for (const b of obj.message?.content ?? []) {
            if (b?.type === 'tool_use' && !openTools.has(b.id)) {
              openTools.set(b.id, b.name);
              opts.onEvent({ type: 'tool-start', id: b.id, name: b.name, input: b.input ?? {} });
            }
          }
          return;
        }
        case 'user': {
          if (obj.parent_tool_use_id) return;
          const content = obj.message?.content;
          if (!Array.isArray(content)) return;
          for (const b of content) {
            if (b?.type !== 'tool_result') continue;
            let text = '';
            let image: { data: string; mimeType: string } | undefined;
            if (typeof b.content === 'string') text = b.content;
            else if (Array.isArray(b.content))
              for (const p of b.content) {
                if (p?.type === 'text') text += (text ? '\n' : '') + p.text;
                else if (p?.type === 'image' && p.source?.data && !image) image = { data: p.source.data, mimeType: p.source.media_type ?? 'image/png' };
              }
            openTools.delete(b.tool_use_id);
            opts.onEvent({ type: 'tool-end', id: b.tool_use_id, text, image, isError: !!b.is_error });
          }
          return;
        }
        case 'result':
          final = { text: typeof obj.result === 'string' ? obj.result : '', sessionId: obj.session_id ?? sessionId, isError: !!obj.is_error };
          opts.onEvent({ type: 'result', text: final.text, isError: final.isError, sessionId: final.sessionId, subtype: obj.subtype });
          return;
        default:
          // The final result line may come without a leading "type" in some versions.
          if (obj.result !== undefined && obj.duration_ms !== undefined && !final) {
            final = { text: String(obj.result ?? ''), sessionId: obj.session_id ?? sessionId, isError: !!obj.is_error };
            opts.onEvent({ type: 'result', text: final.text, isError: final.isError, sessionId: final.sessionId, subtype: obj.subtype });
          }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          /* not JSON */
        }
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-4000);
    });
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new ProviderError(`Couldn’t start Claude Code (${e.message}).`));
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (buf.trim()) {
        try {
          handle(JSON.parse(buf.trim()));
        } catch {
          /* ignore */
        }
      }
      if (aborted) return reject(new AbortedError());
      if (final) return resolve(final);
      const hint = /log ?in|auth|credential/i.test(stderr) ? ' Run `claude` in a terminal once to sign in.' : '';
      reject(new ProviderError(`Claude Code exited with code ${code}.${hint} ${stderr.trim().split('\n').slice(-3).join(' ')}`.trim()));
    });
    child.stdin.end(opts.prompt);
  });
}

/** MCP config that points Claude Code at Clickless's control API. */
export function mcpConfigJson(control: { mcpUrl: string; token: string }): string {
  return JSON.stringify({
    mcpServers: { 'clickless': { type: 'http', url: control.mcpUrl, headers: { Authorization: `Bearer ${control.token}` } } },
  });
}

export function agentArgs(opts: {
  config: ProviderConfig;
  control: { mcpUrl: string; token: string };
  systemPrompt: string;
  resume?: string;
}): string[] {
  const args = [
    '--mcp-config',
    mcpConfigJson(opts.control),
    '--strict-mcp-config',
    // No built-in tools (files, shell, web): only the browser.
    '--tools',
    '',
    '--allowedTools',
    'mcp__clickless',
    '--permission-mode',
    'dontAsk',
    '--append-system-prompt',
    opts.systemPrompt,
  ];
  const model = opts.config.model?.trim();
  if (model && model !== 'default') args.push('--model', model);
  if (opts.resume) args.push('--resume', opts.resume);
  return args;
}

function flatten(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') parts.push(m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n'));
    else if (m.role === 'assistant' && m.text) parts.push(`(Your earlier answer:)\n${m.text}`);
  }
  return parts.join('\n\n---\n\n');
}

/** Plain text completions through Claude Code (AI search answers, tab organizing, connection test). */
export class ClaudeCodeProvider implements ChatProvider {
  readonly kind = 'claude-code';
  constructor(private config: ProviderConfig) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const args = ['--tools', '', '--strict-mcp-config', '--system-prompt', req.system, '--no-session-persistence'];
    const model = this.config.model?.trim();
    if (model && model !== 'default') args.push('--model', model);
    let text = '';
    const res = await runClaude({
      config: this.config,
      prompt: flatten(req.messages),
      args,
      signal: req.signal,
      onEvent: (e) => {
        if (e.type === 'text') {
          text += e.delta;
          req.onText?.(e.delta);
        }
      },
    });
    if (res.isError) throw new ProviderError(`Claude Code: ${res.text || 'the run failed'}`);
    return { text: (res.text || text).trim(), toolCalls: [], stopReason: 'end' };
  }

  async listModels(): Promise<string[]> {
    return CLAUDE_CODE_MODELS;
  }

  /** `claude --version`: proves the CLI exists without spending tokens. */
  version(): Promise<string> {
    const bin = findClaudeBinary(this.config);
    if (!bin) return Promise.reject(new ProviderError('Claude Code CLI not found. Install it or set its path in Settings → AI.'));
    return new Promise((resolve, reject) => {
      const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.on('error', (e) => reject(new ProviderError(`Couldn’t run Claude Code (${e.message}).`)));
      child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new ProviderError(`claude --version exited with ${code}`))));
    });
  }
}
