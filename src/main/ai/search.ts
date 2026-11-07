// Web search through the browser itself: no API keys. Results are scraped from a hidden page of the
// chosen engine (falling back to the others), then the top results are read in parallel.

import type { AIDeps } from '../contracts';
import type { SearchResult, Settings } from '../../shared/types';
import { hostOf, normalizeUrl } from './util';

type Backend = Settings['askBackend'];

/** Each extractor is a self-contained function expression evaluated inside the results page. */
const EXTRACTORS: Record<Exclude<Backend, 'searxng'>, { url: (q: string) => string; waitFor: string; fn: string }> = {
  duckduckgo: {
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    waitFor: '.result, .no-results, #links',
    fn: `() => {
      const out = [];
      for (const r of document.querySelectorAll('.result')) {
        if (r.classList.contains('result--ad')) continue;
        const a = r.querySelector('a.result__a');
        if (!a) continue;
        let href = a.getAttribute('href') || '';
        try {
          const u = new URL(href, location.href);
          const target = u.searchParams.get('uddg');
          href = target ? target : u.href;
        } catch (e) {}
        if (!/^https?:/.test(href) || /duckduckgo\\.com\\/y\\.js/.test(href)) continue;
        const sn = r.querySelector('.result__snippet');
        out.push({ title: (a.textContent || '').trim(), url: href, snippet: sn ? (sn.textContent || '').trim() : '' });
      }
      return out;
    }`,
  },
  google: {
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&num=10`,
    waitFor: '#search, #rso, form[action*="consent"]',
    fn: `() => {
      const out = [];
      const seen = new Set();
      for (const h3 of document.querySelectorAll('#search a h3, #rso a h3')) {
        const a = h3.closest('a');
        if (!a) continue;
        const href = a.href;
        if (!/^https?:/.test(href) || /^https?:\\/\\/([a-z]+\\.)?google\\.[a-z.]+\\//.test(href) || seen.has(href)) continue;
        if (a.closest('[data-text-ad], #tads, #bottomads')) continue;
        seen.add(href);
        const box = a.closest('div.g, div.MjjYud, div[data-hveid]') || a.parentElement;
        const s = box && box.querySelector('.VwiC3b, [data-sncf="1"], div[style*="line-clamp"], span.aCOpRe');
        out.push({ title: (h3.textContent || '').trim(), url: href, snippet: s ? (s.textContent || '').trim() : '' });
      }
      return out;
    }`,
  },
  bing: {
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en`,
    waitFor: '#b_results',
    fn: `() => {
      const decode = (href) => {
        try {
          const u = new URL(href);
          if (/bing\\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/')) {
            const p = u.searchParams.get('u');
            if (p && p.startsWith('a1')) {
              const b = p.slice(2).replace(/-/g, '+').replace(/_/g, '/');
              return decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4))));
            }
          }
        } catch (e) {}
        return href;
      };
      const out = [];
      for (const li of document.querySelectorAll('#b_results > li.b_algo')) {
        const a = li.querySelector('h2 a');
        if (!a) continue;
        const href = decode(a.href);
        if (!/^https?:/.test(href)) continue;
        const s = li.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_algoSlug');
        out.push({ title: (a.textContent || '').trim(), url: href, snippet: s ? (s.textContent || '').trim() : '' });
      }
      return out;
    }`,
  },
  brave: {
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`,
    waitFor: '[data-type="web"]',
    fn: `() => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('[data-type="web"]')) {
        const a = [...el.querySelectorAll('a[href^="http"]')].find((x) => !/(^|\\.)brave\\.com\\//.test(x.href.replace(/^https?:\\/\\//, '')));
        if (!a || seen.has(a.href)) continue;
        seen.add(a.href);
        const t = a.querySelector('[title]') || el.querySelector('.title, .snippet-title, .search-snippet-title');
        const title = (t && (t.getAttribute('title') || t.textContent)) || a.textContent || '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll('a, style, script').forEach((x) => x.remove());
        const snippet = (clone.textContent || '').replace(/\\s+/g, ' ').trim();
        out.push({ title: title.trim(), url: a.href, snippet });
      }
      return out;
    }`,
  },
};

// Brave first: good results and no consent wall. Google next (fine once the user accepted its cookies),
// DuckDuckGo's HTML endpoint often shows a captcha to automated readers, Bing's quality varies.
const ORDER: Backend[] = ['brave', 'google', 'duckduckgo', 'bing'];

async function searxng(base: string, query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`${base.replace(/\/+$/, '')}/search?format=json&q=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) throw new Error(`SearXNG ${res.status}`);
  const j: any = await res.json();
  return (j?.results ?? []).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.content ?? '') }));
}

function favicon(url: string): string | undefined {
  try {
    return `${new URL(url).origin}/favicon.ico`;
  } catch {
    return undefined;
  }
}

function clean(results: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!r?.url || !/^https?:/.test(r.url)) continue;
    const key = normalizeUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: (r.title || hostOf(r.url)).replace(/\s+/g, ' ').trim().slice(0, 200),
      url: r.url,
      snippet: (r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      favicon: r.favicon ?? favicon(r.url),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface SearchOutcome {
  results: SearchResult[];
  backend: Backend | null;
  errors: string[];
}

/** Searches with the configured backend, falling back to the others until one returns results. */
export async function webSearch(deps: AIDeps, query: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchOutcome> {
  const settings = deps.settings();
  const limit = opts.limit ?? 8;
  const primary = settings.askBackend ?? 'brave';
  const chain: Backend[] = [primary, ...ORDER.filter((b) => b !== primary)];
  if (primary !== 'searxng' && settings.searxngURL) chain.push('searxng');
  const errors: string[] = [];
  for (const backend of chain) {
    if (opts.signal?.aborted) break;
    try {
      let raw: SearchResult[];
      if (backend === 'searxng') {
        if (!settings.searxngURL) continue;
        raw = await searxng(settings.searxngURL, query, opts.signal);
      } else {
        const ex = EXTRACTORS[backend];
        raw = await deps.browser.headless.evaluate<SearchResult[]>(ex.url(query), ex.fn, {
          timeoutMs: 12000,
          waitForSelector: ex.waitFor,
          signal: opts.signal,
        });
      }
      const results = clean(Array.isArray(raw) ? raw : [], limit);
      if (results.length) return { results, backend, errors };
      errors.push(`${backend}: no results`);
    } catch (e) {
      errors.push(`${backend}: ${(e as Error).message}`);
    }
  }
  return { results: [], backend: null, errors };
}

export interface ReadPage {
  n: number;
  url: string;
  title: string;
  markdown: string;
}

/** Reads the first `count` results in parallel; failures are skipped. `n` is the 1-based result number. */
export async function readResults(
  deps: AIDeps,
  results: SearchResult[],
  count: number,
  opts: { signal?: AbortSignal; onPage?: (p: ReadPage) => void } = {},
): Promise<ReadPage[]> {
  const picked = results.slice(0, Math.max(0, count));
  const pages = await Promise.all(
    picked.map(async (r, i) => {
      try {
        const page = await deps.browser.headless.read(r.url, { timeoutMs: 8000, maxChars: 12000, signal: opts.signal });
        if (page.error || !page.markdown?.trim()) return null;
        const p: ReadPage = { n: i + 1, url: page.url || r.url, title: page.title || r.title, markdown: page.markdown };
        opts.onPage?.(p);
        return p;
      } catch {
        return null;
      }
    }),
  );
  return pages.filter((p): p is ReadPage => !!p);
}

export async function search(
  deps: AIDeps,
  query: string,
  opts: { limit?: number; read?: number; signal?: AbortSignal } = {},
): Promise<{ results: SearchResult[]; pages: ReadPage[] }> {
  const { results, errors } = await webSearch(deps, query, opts);
  if (!results.length && errors.length && !opts.signal?.aborted) throw new Error(`Search failed (${errors.join('; ')})`);
  const pages = opts.read ? await readResults(deps, results, opts.read, { signal: opts.signal }) : [];
  return { results, pages };
}
