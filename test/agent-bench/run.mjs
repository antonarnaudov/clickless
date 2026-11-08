// Agent benchmark: runs Claude Code (headless) against the local bench site through Clickless's
// MCP server and scores each task by what the site recorded — not by what the agent claims.
//
//   CLICKLESS_HOME=… node test/agent-bench/run.mjs [--model sonnet] [--only signup,shop] [--out report.md]
//
// Needs a running Clickless (it reads the discovery file for the MCP address and token) and the
// `claude` CLI. Each task runs with --strict-mcp-config, so the agent only has Clickless's tools.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSite } from './site.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const MODEL = opt('model', 'sonnet');
const ONLY = opt('only', '')?.split(',').filter(Boolean);
const OUT = opt('out', path.join(os.tmpdir(), `clickless-agent-bench-${Date.now()}.md`));
/** With --log <dir>: each task's calls, inputs and results (trimmed), for seeing where time goes. */
const LOG = opt('log', '');
const home = process.env.CLICKLESS_HOME ? path.resolve(process.env.CLICKLESS_HOME) : path.join(os.homedir(), '.clickless');
const disc = JSON.parse(fs.readFileSync(path.join(home, 'control.json'), 'utf8'));
const site = startSite();
const B = 'http://127.0.0.1:8765';

const cheapestBerlin = site.FLIGHTS.filter((f) => f.to === 'Berlin' && f.stops === 0).sort((a, b) => a.price - b.price)[0];

const TASKS = [
  {
    id: 'signup',
    title: '3-step signup with validation, radio, long select, date, checkboxes, custom switch',
    prompt: `Create an account at ${B}/signup for Ada Lovelace (ada@example.com), password "Analytical-Engine-1843" (it's a test site), Pro plan, country Portugal, born 1990-12-10, interests Math and Music, and turn the newsletter OFF. Agree to the terms and finish. Reply with the confirmation code only.`,
    check: (r, text) => {
      const s = r.find((x) => x.kind === 'signup');
      const ok = s && s.name === 'Ada Lovelace' && s.email === 'ada@example.com' && s.plan === 'Pro' && s.country === 'Portugal' && s.birth === '1990-12-10' && s.interests.sort().join() === 'Math,Music' && s.newsletter === false;
      return { ok: !!ok && text.includes(s.code), detail: s ? `${s.plan}, ${s.country}, ${s.birth}, [${s.interests}], newsletter ${s.newsletter}, code ${s.code}` : 'no signup' };
    },
  },
  {
    id: 'shop',
    title: 'shop: search/filter, product options (size, color swatch, qty), coupon, checkout',
    prompt: `On ${B}/shop buy 2 pairs of "Trail Runner 2" shoes in size 42, color blue, plus the cheapest water bottle in the shop. Apply coupon SPRING10, choose express shipping, and ship to Ada Lovelace, Rua Augusta 12, Lisbon, 1100-048. Place the order and reply with the order number and the total charged.`,
    check: (r, text) => {
      const o = r.find((x) => x.kind === 'order');
      const items = o?.items ?? [];
      const shoes = items.filter((i) => i.name === 'Trail Runner 2');
      const shoeQty = shoes.reduce((n, i) => n + i.qty, 0);
      const ok = o && shoeQty === 2 && shoes.every((i) => i.size === '42' && i.color === 'blue') && items.some((i) => i.name === 'Squeeze Bottle') && items.length === shoes.length + 1 && o.coupon === 'SPRING10' && o.shipping === 'express' && /lisbon/i.test(o.city) && o.zip.replace(/\s/g, '') === '1100-048';
      return { ok: !!ok && text.includes(o.order) && text.includes(o.total.toFixed(2)), detail: o ? `${items.map((i) => `${i.qty}×${i.name}${i.size ? ` ${i.size}/${i.color}` : ''}`).join(', ')}, ${o.coupon}, ${o.shipping}, €${o.total.toFixed(2)}, ${o.order}` : 'no order' };
    },
  },
  {
    id: 'flights',
    title: 'paged, sortable table + filter + details modal',
    prompt: `On ${B}/flights find the cheapest direct flight from Lisbon to Berlin and open its details. Reply with the flight number, the price and the checked baggage allowance.`,
    check: (r, text) => {
      const viewed = r.some((x) => x.kind === 'flight-viewed' && x.no === cheapestBerlin.no);
      const ok = viewed && text.includes(cheapestBerlin.no) && text.includes(String(cheapestBerlin.price)) && text.toLowerCase().includes(cheapestBerlin.bag.toLowerCase().replace(' ', ''))
        ? true
        : viewed && text.includes(cheapestBerlin.no) && text.includes(String(cheapestBerlin.price)) && text.includes(cheapestBerlin.bag.split(' ')[0]);
      return { ok: !!ok, detail: `expected ${cheapestBerlin.no} €${cheapestBerlin.price} ${cheapestBerlin.bag}; details opened: ${viewed}` };
    },
  },
  {
    id: 'support',
    title: 'form inside a cross-origin iframe, inside shadow DOM; FAQ behind "Load more"',
    prompt: `On ${B}/support, first find what the FAQ says about refunds for double charges (you may need to load more questions). Then open a support ticket: category Billing, subject "Double charge on my card", message "I was charged twice for order ORD-4101.", priority High. Reply with the ticket number and the refund timeline from the FAQ.`,
    check: (r, text) => {
      const t = r.find((x) => x.kind === 'ticket');
      const ok = t && t.category === 'Billing' && /double charge/i.test(t.subject) && /ORD-4101/.test(t.message) && t.priority === 'High';
      return { ok: !!ok && text.includes(t.ticket) && /3 business days|three business days/i.test(text), detail: t ? `${t.category}, ${t.priority}, ${t.ticket}` : 'no ticket' };
    },
  },
  {
    id: 'tabs',
    title: 'information from a page that opens in a new tab, typed back into the first tab',
    prompt: `On ${B}/docs, connect the project using the live (not revoked) project key from the keys page. Reply with the project name it connected to.`,
    check: (r, text) => {
      const k = r.find((x) => x.kind === 'key' && x.ok);
      return { ok: !!k && /orbit-demo/i.test(text), detail: k ? 'connected with the live key' : `tries: ${r.filter((x) => x.kind === 'key').map((x) => x.key).join(', ') || 'none'}` };
    },
  },
  {
    id: 'web',
    title: 'real web: search Wikipedia, follow to the right article, then a second site',
    prompt: `Using the browser: on Wikipedia, find out in which year the first web browser, WorldWideWeb, was created and who wrote it. Then open news.ycombinator.com and tell me the title of the #1 story right now. Reply in two short lines.`,
    check: (_r, text) => ({ ok: /1990/.test(text) && /Berners-Lee/i.test(text) && text.split('\n').filter(Boolean).length >= 2, detail: text.replace(/\s+/g, ' ').slice(0, 140) }),
  },
];

function runClaude(prompt, id = 'task') {
  const cfg = path.join(os.tmpdir(), `clickless-bench-mcp-${process.pid}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { clickless: { type: 'http', url: disc.mcpUrl, headers: { Authorization: `Bearer ${disc.token}` } } } }), { mode: 0o600 });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('claude', ['-p', prompt, '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__clickless', '--output-format', 'stream-json', '--verbose', '--model', MODEL, '--max-turns', '60'], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const tools = [];
    const trace = [];
    let result = null;
    let last = t0;
    p.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          // only Clickless calls count (Claude Code's own ToolSearch, which loads deferred tools, doesn't)
          if (m.type === 'assistant') {
            for (const b of m.message?.content ?? []) {
              if (b.type === 'tool_use' && b.name.startsWith('mcp__clickless__')) tools.push(b.name.replace(/^mcp__clickless__/, ''));
              if (b.type === 'tool_use') trace.push({ t: ((Date.now() - t0) / 1000).toFixed(1), think: ((Date.now() - last) / 1000).toFixed(1), call: b.name.replace(/^mcp__clickless__/, ''), input: b.input });
              if (b.type === 'text' && b.text.trim()) trace.push({ t: ((Date.now() - t0) / 1000).toFixed(1), say: b.text.slice(0, 400) });
            }
            last = Date.now();
          }
          if (m.type === 'user')
            for (const b of m.message?.content ?? []) {
              if (b.type !== 'tool_result') continue;
              const text = Array.isArray(b.content) ? b.content.map((x) => x.text ?? `[${x.type}]`).join('\n') : String(b.content ?? '');
              trace.push({ t: ((Date.now() - t0) / 1000).toFixed(1), result: text.slice(0, 1500) });
              last = Date.now();
            }
          if (m.type === 'result') result = m;
        } catch {
          /* partial line */
        }
      }
    });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.on('close', () => {
      fs.rmSync(cfg, { force: true });
      if (LOG) {
        fs.mkdirSync(LOG, { recursive: true });
        fs.writeFileSync(path.join(LOG, `${id}.json`), JSON.stringify(trace, null, 1));
      }
      resolve({ ms: Date.now() - t0, tools, text: String(result?.result ?? ''), turns: result?.num_turns, cost: result?.total_cost_usd, error: result ? null : err.slice(-400) });
    });
  });
}

const rows = [];
for (const t of TASKS) {
  if (ONLY?.length && !ONLY.includes(t.id)) continue;
  site.results.length = 0;
  process.stdout.write(`▶ ${t.id}: ${t.title}\n`);
  const r = await runClaude(t.prompt, t.id);
  const c = t.check(site.results, r.text);
  rows.push({ ...t, ...r, ...c });
  process.stdout.write(`  ${c.ok ? 'PASS' : 'FAIL'} · ${r.tools.length} browser calls · ${(r.ms / 1000).toFixed(0)} s · ${c.detail}\n  tools: ${r.tools.join(' → ')}\n  answer: ${r.text.replace(/\s+/g, ' ').slice(0, 200)}\n${r.error ? `  error: ${r.error}\n` : ''}`);
}
site.close();

const md = [
  `# Clickless agent benchmark`,
  ``,
  `Claude Code (\`--model ${MODEL}\`) over Clickless MCP, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Scored by what the site recorded.`,
  ``,
  `| Task | Result | Browser calls | Time | What happened |`,
  `|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.id} — ${r.title} | ${r.ok ? '✅' : '❌'} | ${r.tools.length} | ${(r.ms / 1000).toFixed(0)} s | ${String(r.detail).replace(/\|/g, '/')} |`),
  ``,
  `Passed ${rows.filter((r) => r.ok).length} of ${rows.length}; ${rows.reduce((n, r) => n + r.tools.length, 0)} browser calls in total.`,
  ``,
  ...rows.map((r) => `- **${r.id}**: ${r.tools.join(' → ')}`),
].join('\n');
fs.writeFileSync(OUT, md + '\n');
console.log(`\n${md}\n\nreport: ${OUT}`);
