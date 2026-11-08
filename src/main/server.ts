// The local control API on 127.0.0.1: MCP (Streamable HTTP) at /mcp and plain JSON at /v1/*.
// Every request needs the bearer token from ~/.clickless/control.json.

import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AI, Browser, ToolRegistry, ToolResult } from './contracts';
import { exportTools } from './tools';

export interface ControlServerDeps {
  browser: Browser;
  tools: ToolRegistry;
  ai: () => AI | null;
  token: () => string;
  version: string;
  noteClient(name: string): void;
  /** Dev only (CLICKLESS_DEBUG=1): PNG captures of the UI layers. */
  debugCapture?(): Promise<Record<string, string>>;
  debugCommand?(c: unknown): Promise<unknown>;
  debugShellMouse?(steps: unknown): Promise<unknown>;
  debugShellEval?(code: string): Promise<unknown>;
  debugMenu?(accelerator: string): unknown;
  /** Import tabs from another browser on this Mac (GET lists sources, POST {source} imports). */
  importSources?(): unknown;
  importFrom?(source: string): unknown;
  /** Encrypted backups: GET status, POST runs one now. */
  backupStatus?(): unknown;
  backupNow?(): Promise<unknown>;
  trackAbort(): AbortController;
  untrackAbort(ac: AbortController): void;
}

const MAX_BODY = 8 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = typeof body === 'string' ? body : JSON.stringify(body, null, 1);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function toMcpContent(r: ToolResult) {
  const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [{ type: 'text', text: r.text }];
  for (const img of r.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  return { content, isError: r.isError || undefined };
}

export class ControlServer {
  private server: http.Server | null = null;
  private sessions = new Map<string, { transport: StreamableHTTPServerTransport; client: string; lastSeen: number }>();
  port: number | null = null;

  constructor(private deps: ControlServerDeps) {}

  private authorized(req: http.IncomingMessage, url: URL): boolean {
    const expected = Buffer.from(this.deps.token());
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? (req.headers['x-clickless-token'] as string | undefined) ?? url.searchParams.get('token') ?? '';
    const got = Buffer.from(header);
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  /** Blocks DNS-rebinding and drive-by requests from web pages. */
  private sameHost(req: http.IncomingMessage): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return false;
    return true;
  }

  private makeMcpServer(getClient: () => string): Server {
    const server = new Server(
      { name: 'clickless', version: this.deps.version },
      { capabilities: { tools: {} }, instructions: this.deps.tools.instructions },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exportTools(this.deps.tools, 'mcp') as any }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const client = getClient();
      this.deps.noteClient(client);
      const ac = this.deps.trackAbort();
      const onAbort = () => ac.abort();
      extra.signal?.addEventListener('abort', onAbort);
      try {
        const r = await this.deps.tools.call(req.params.name, (req.params.arguments ?? {}) as Record<string, any>, { browser: this.deps.browser, source: client, signal: ac.signal });
        return toMcpContent(r) as any;
      } finally {
        extra.signal?.removeEventListener('abort', onAbort);
        this.deps.untrackAbort(ac);
      }
    });
    return server;
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (req.method === 'POST') {
      const body = await readBody(req);
      let entry = sid ? this.sessions.get(sid) : undefined;
      if (!entry) {
        if (sid || !isInitializeRequest(body)) {
          return send(res, sid ? 404 : 400, { jsonrpc: '2.0', error: { code: -32000, message: sid ? 'Unknown session; reconnect.' : 'Send initialize first.' }, id: null });
        }
        const clientInfo = (body as any)?.params?.clientInfo;
        const client = String(clientInfo?.name ?? req.headers['user-agent'] ?? 'mcp-client').slice(0, 40);
        const holder: { client: string } = { client };
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            this.sessions.set(id, { transport, client: holder.client, lastSeen: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) this.sessions.delete(transport.sessionId);
        };
        const server = this.makeMcpServer(() => holder.client);
        await server.connect(transport);
        this.deps.noteClient(client);
        await transport.handleRequest(req, res, body);
        return;
      }
      entry.lastSeen = Date.now();
      await entry.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      const entry = sid ? this.sessions.get(sid) : undefined;
      if (!entry) return send(res, 400, { error: 'Missing or unknown mcp-session-id' });
      await entry.transport.handleRequest(req, res);
      return;
    }
    send(res, 405, { error: 'method not allowed' });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!this.sameHost(req)) return send(res, 403, { error: 'forbidden host/origin' });
    if (url.pathname === '/v1/health' || url.pathname === '/health') return send(res, 200, { ok: true, name: 'clickless', version: this.deps.version });
    if (!this.authorized(req, url)) {
      res.setHeader('www-authenticate', 'Bearer');
      return send(res, 401, { error: 'Missing or wrong token. It is in ~/.clickless/control.json (field "token").' });
    }
    const client = String(req.headers['x-clickless-client'] ?? req.headers['user-agent'] ?? 'http').slice(0, 40);

    if (url.pathname === '/mcp') return this.handleMcp(req, res);

    if (url.pathname === '/v1/tools' && req.method === 'GET') {
      const format = (url.searchParams.get('format') ?? 'json') as 'openai' | 'anthropic' | 'mcp' | 'json';
      return send(res, 200, exportTools(this.deps.tools, format));
    }
    if (url.pathname === '/v1/instructions') return send(res, 200, this.deps.tools.instructions);
    if (url.pathname === '/v1/debug/ui' && process.env.CLICKLESS_DEBUG && this.deps.debugCapture) return send(res, 200, await this.deps.debugCapture());
    if (url.pathname === '/v1/debug/cmd' && process.env.CLICKLESS_DEBUG && this.deps.debugCommand) return send(res, 200, { result: (await this.deps.debugCommand(await readBody(req))) ?? null });
    if (url.pathname === '/v1/import' && this.deps.importFrom) {
      if (req.method === 'GET') return send(res, 200, this.deps.importSources?.() ?? []);
      const body = ((await readBody(req)) ?? {}) as { source?: string };
      if (!body.source) return send(res, 400, { error: 'Give {"source": "arc" | "comet" | "chrome" | "brave" | "edge"}' });
      try {
        return send(res, 200, this.deps.importFrom(String(body.source).toLowerCase()));
      } catch (err) {
        return send(res, 422, { error: (err as Error).message });
      }
    }
    if (url.pathname === '/v1/backup' && this.deps.backupNow) {
      if (req.method === 'GET') return send(res, 200, this.deps.backupStatus?.() ?? {});
      try {
        return send(res, 200, await this.deps.backupNow());
      } catch (err) {
        return send(res, 422, { error: (err as Error).message });
      }
    }
    if (url.pathname === '/v1/debug/menu' && process.env.CLICKLESS_DEBUG && this.deps.debugMenu) return send(res, 200, this.deps.debugMenu(String(((await readBody(req)) as any)?.accelerator ?? '')));
    if (url.pathname === '/v1/debug/shell-eval' && process.env.CLICKLESS_DEBUG && this.deps.debugShellEval) return send(res, 200, { result: (await this.deps.debugShellEval(String(((await readBody(req)) as any)?.code ?? ''))) ?? null });
    if (url.pathname === '/v1/debug/mouse' && process.env.CLICKLESS_DEBUG && this.deps.debugShellMouse) return send(res, 200, await this.deps.debugShellMouse(await readBody(req)));
    if (url.pathname === '/v1/tabs' && req.method === 'GET') return send(res, 200, this.deps.browser.listTabs({ all: url.searchParams.get('all') === '1' }));

    const toolMatch = /^\/v1\/(?:tools\/)?([a-z_]+)$/.exec(url.pathname);
    if (req.method === 'POST' && url.pathname === '/v1/agent') {
      const ai = this.deps.ai();
      if (!ai) return send(res, 503, { error: 'AI not ready' });
      const body = ((await readBody(req)) ?? {}) as { task?: string; tab?: string };
      if (!body.task) return send(res, 400, { error: 'Give {"task": "..."}' });
      this.deps.noteClient(client);
      const ac = this.deps.trackAbort();
      req.on('close', () => !res.writableEnded && ac.abort());
      try {
        const r = await ai.agent.run(body.task, { tabId: body.tab, signal: ac.signal });
        return send(res, 200, r);
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      } finally {
        this.deps.untrackAbort(ac);
      }
    }
    if (req.method === 'POST' && toolMatch && this.deps.tools.get(toolMatch[1])) {
      const args = ((await readBody(req)) ?? {}) as Record<string, any>;
      this.deps.noteClient(client);
      const ac = this.deps.trackAbort();
      req.on('close', () => !res.writableEnded && ac.abort());
      try {
        const r = await this.deps.tools.call(toolMatch[1], args, { browser: this.deps.browser, source: client, signal: ac.signal });
        if (url.searchParams.get('format') === 'text') return send(res, r.isError ? 422 : 200, r.text);
        return send(res, 200, r);
      } finally {
        this.deps.untrackAbort(ac);
      }
    }
    if (url.pathname === '/' || url.pathname === '/v1') {
      return send(
        res,
        200,
        [
          'Clickless control API',
          '  POST /mcp                      MCP (Streamable HTTP)',
          '  GET  /v1/tools?format=openai|anthropic|mcp',
          '  POST /v1/<tool>                observe, act, read, search, tabs, screenshot, evaluate, handoff  (JSON args)',
          '  POST /v1/agent {"task": "…"}   run the built-in agent',
          '  POST /v1/import {"source": "arc"}  import tabs from Arc, Comet, Chrome, Brave or Edge (GET lists them)',
          '  POST /v1/backup                 encrypted backup now, to the folder or private repo set in Settings (GET: status)',
          '  GET  /v1/tabs, /v1/instructions, /v1/health',
        ].join('\n'),
      );
    }
    send(res, 404, { error: `No route ${req.method} ${url.pathname}` });
  }

  async start(preferredPort: number): Promise<number> {
    await this.stop();
    const tryPort = (port: number) =>
      new Promise<http.Server>((resolve, reject) => {
        const s = http.createServer((req, res) => {
          this.handle(req, res).catch((err) => {
            if (!res.headersSent) send(res, 500, { error: (err as Error).message });
            else res.end();
          });
        });
        s.requestTimeout = 0; // long tool calls (handoff) are fine
        s.headersTimeout = 30000;
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => resolve(s));
      });
    let lastErr: unknown;
    for (let i = 0; i < 10; i++) {
      try {
        this.server = await tryPort(preferredPort + i);
        this.port = preferredPort + i;
        return this.port;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('could not bind a port');
  }

  async stop() {
    for (const s of this.sessions.values()) await s.transport.close().catch(() => {});
    this.sessions.clear();
    if (this.server) {
      await new Promise<void>((r) => this.server!.close(() => r()));
      this.server.closeAllConnections?.();
    }
    this.server = null;
    this.port = null;
  }
}
