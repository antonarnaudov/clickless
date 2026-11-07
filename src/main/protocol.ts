// clickless:// — internal pages (new tab, AI answers, errors) served from the built UI.

import { net, protocol, type Session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_SCHEME } from '../shared/settings';

export function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
  ]);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function errorPage(u: URL): Response {
  const code = u.searchParams.get('code') ?? '';
  const desc = u.searchParams.get('desc') ?? 'The page could not be loaded.';
  const target = u.searchParams.get('url') ?? '';
  let host = target;
  try {
    host = new URL(target).host;
  } catch {
    /* keep */
  }
  const friendly: Record<string, string> = {
    '-105': `Couldn’t find ${host}. Check the address or your connection.`,
    '-106': 'You’re offline. Check your connection.',
    '-102': `${host} refused to connect.`,
    '-118': `${host} took too long to respond.`,
    '-137': `Couldn’t find ${host}.`,
    '-200': `${host} has a certificate problem, so Clickless didn’t open it.`,
    '-201': `${host} has a certificate problem, so Clickless didn’t open it.`,
    '-202': `${host} has a certificate problem, so Clickless didn’t open it.`,
  };
  const msg = friendly[code] ?? desc;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Page not available</title>
<meta name="color-scheme" content="light dark">
<style>
:root{--bg:#f6f8f6;--fg:#0f1f1b;--mute:#62716c;--card:#fff;--line:#e3e9e6;--accent:#0f1f1b;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0b1411;--fg:#eef3ef;--mute:#93a39d;--card:#121d1a;--line:#22302c;--accent:#eef3ef;--accent-ink:#0b1411}}
body{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif}
.card{max-width:460px;padding:36px;border-radius:18px;background:var(--card);border:1px solid var(--line);box-shadow:0 20px 50px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 18px;color:var(--mute)}code{font-size:12px;color:var(--mute);word-break:break-all}
button{appearance:none;border:0;border-radius:10px;padding:9px 16px;background:var(--accent);color:var(--accent-ink);font:600 14px/1 inherit;cursor:pointer}
</style></head><body><div class="card"><h1>This page isn’t available</h1><p>${esc(msg)}</p>
<button onclick="location.replace(${esc(JSON.stringify(target))})">Try again</button><p style="margin-top:18px"><code>${esc(target)} · ${esc(code)}</code></p></div></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export function handleScheme(ses: Session, rendererDir: string, devUrl?: string) {
  ses.protocol.handle(APP_SCHEME, async (req) => {
    const u = new URL(req.url);
    if (u.host === 'error') return errorPage(u);
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/') || !path.extname(rel)) rel = 'internal.html';
    if (devUrl) return net.fetch(`${devUrl.replace(/\/$/, '')}/${rel}${rel === 'internal.html' ? u.search : ''}`);
    const file = path.normalize(path.join(rendererDir, rel));
    if (!file.startsWith(rendererDir)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}
