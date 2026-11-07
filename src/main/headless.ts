// Hidden pages for background work: reading search results, extracting data. They share the
// user's session (cookies, logins) but are never shown and never steal focus.

import { WebContentsView, type Session, type WebContents } from 'electron';
import { IPC } from '../shared/ipc';
import type { ReadResult, RpcResponse } from '../shared/engine';
import type { HeadlessPage } from './contracts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Headless {
  private running = 0;
  private queue: (() => void)[] = [];
  private readonly max = 5;

  constructor(
    private ses: Session,
    private preload: string,
  ) {}

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  private create(): WebContents {
    const view = new WebContentsView({
      webPreferences: {
        preload: this.preload,
        sandbox: true,
        contextIsolation: true,
        session: this.ses,
        backgroundThrottling: false,
        images: false,
        autoplayPolicy: 'document-user-activation-required',
      },
    });
    view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
    const wc = view.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-prevent-unload', (e) => e.preventDefault());
    return wc;
  }

  private async load(wc: WebContents, url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let failed: string | null = null;
    wc.on('did-fail-load', (_e, code, desc, _u, isMain) => {
      if (isMain && code !== -3) failed = `${desc} (${code})`;
    });
    const domReady = new Promise<void>((r) => wc.once('dom-ready', () => r()));
    wc.loadURL(url).catch(() => {});
    await Promise.race([domReady, sleep(timeoutMs)]);
    if (failed) throw new Error(failed);
    // give client-rendered pages a moment, but stop early when the DOM goes quiet
    const settleUntil = Math.min(deadline, Date.now() + 2500);
    while (Date.now() < settleUntil) {
      if (signal?.aborted) throw new Error('aborted');
      const quiet = await this.rpc<{ quietMs: number }>(wc, 'ping', {}, 800).catch(() => null);
      if (quiet && quiet.quietMs > 400) break;
      await sleep(150);
    }
    if (failed) throw new Error(failed);
  }

  private rpcSeq = 0;
  private rpc<T>(wc: WebContents, method: string, params: unknown, timeout: number): Promise<T> {
    const id = ++this.rpcSeq;
    return new Promise((resolve, reject) => {
      const onResult = (_e: unknown, res: RpcResponse) => {
        if (res.id !== id) return;
        clearTimeout(timer);
        wc.ipc.removeListener(IPC.rpcResult, onResult as any);
        if (res.ok) resolve(res.result as T);
        else reject(new Error(res.error));
      };
      const timer = setTimeout(() => {
        wc.ipc.removeListener(IPC.rpcResult, onResult as any);
        reject(new Error(`timeout ${method}`));
      }, timeout);
      wc.ipc.on(IPC.rpcResult, onResult as any);
      try {
        wc.mainFrame.send(IPC.rpc, { id, method, params });
      } catch (err) {
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  read(url: string, opts: { timeoutMs?: number; maxChars?: number; signal?: AbortSignal } = {}): Promise<HeadlessPage> {
    return this.slot(async () => {
      const wc = this.create();
      const timeout = opts.timeoutMs ?? 10000;
      try {
        await this.load(wc, url, timeout, opts.signal);
        const r = await this.rpc<ReadResult>(wc, 'read', { mode: 'article', links: false }, Math.max(3000, timeout / 2));
        let md = r.markdown ?? '';
        const max = opts.maxChars ?? 20000;
        if (md.length > max) md = md.slice(0, max) + '\n…(truncated)';
        return { url: wc.getURL() || url, title: r.title || wc.getTitle(), markdown: md };
      } catch (err) {
        return { url, title: '', markdown: '', error: (err as Error).message };
      } finally {
        if (!wc.isDestroyed()) wc.close();
      }
    });
  }

  evaluate<T = unknown>(url: string, fnSource: string, opts: { timeoutMs?: number; waitForSelector?: string; signal?: AbortSignal } = {}): Promise<T> {
    return this.slot(async () => {
      const wc = this.create();
      const timeout = opts.timeoutMs ?? 12000;
      try {
        await this.load(wc, url, timeout, opts.signal);
        if (opts.waitForSelector) {
          await this.rpc(wc, 'waitFor', { selector: opts.waitForSelector, timeout: Math.min(5000, timeout) }, Math.min(6000, timeout + 1000)).catch(() => {});
        }
        const v = await wc.mainFrame.executeJavaScript(`(${fnSource})()`, false);
        return JSON.parse(JSON.stringify(v ?? null)) as T;
      } finally {
        if (!wc.isDestroyed()) wc.close();
      }
    });
  }
}
