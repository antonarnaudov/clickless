// Page → clean markdown, for `read` and for AI search reading result pages.

import { Readability } from '@mozilla/readability';
import type { ReadParams, ReadResult } from '../../shared/engine';
import { OVERLAY_ID } from './dom';

const BLOCK = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'ADDRESS',
  'DL', 'DT', 'DD', 'FORM', 'FIELDSET', 'DETAILS', 'SUMMARY', 'CENTER',
]);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'HEAD', 'META', 'LINK', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'VIDEO', 'AUDIO', 'MAP', 'DIALOG']);

interface Opts {
  live: boolean; // walking the live document: check visibility
  baseURI: string;
  /** Keep link URLs inline (costs tokens). */
  links: boolean;
}

function abs(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function isHidden(el: Element, o: Opts): boolean {
  if (!o.live) return el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true';
  if (el.id === OVERLAY_ID) return true;
  const he = el as HTMLElement;
  if (typeof he.checkVisibility === 'function') return !he.checkVisibility({ visibilityProperty: true } as any);
  const cs = getComputedStyle(el);
  return cs.display === 'none' || cs.visibility === 'hidden';
}

function inline(node: Node, o: Opts): string {
  if (node.nodeType === 3) return (node.textContent || '').replace(/\s+/g, ' ');
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (SKIP.has(el.tagName)) return el.tagName === 'BUTTON' && !o.live ? '' : '';
  if (isHidden(el, o)) return '';
  const kids = () => Array.from(el.childNodes).map((n) => inline(n, o)).join('');
  switch (el.tagName) {
    case 'BR':
      return '\n';
    case 'STRONG':
    case 'B': {
      const t = kids().trim();
      return t ? ` **${t}** ` : '';
    }
    case 'EM':
    case 'I': {
      const t = kids().trim();
      return t ? ` *${t}* ` : '';
    }
    case 'CODE': {
      const t = (el.textContent || '').trim();
      return t ? ` \`${t}\` ` : '';
    }
    case 'A': {
      const t = kids().replace(/\s+/g, ' ').trim();
      const href = el.getAttribute('href');
      if (!t) return '';
      if (!o.links || !href || href.startsWith('#') || href.startsWith('javascript:')) return ` ${t} `;
      return ` [${t}](${abs(href, o.baseURI)}) `;
    }
    case 'IMG': {
      const alt = (el as HTMLImageElement).alt?.trim();
      return alt ? ` [image: ${alt}] ` : '';
    }
    case 'SUP':
    case 'SUB':
      return kids();
    default:
      if (BLOCK.has(el.tagName) || /^H[1-6]$/.test(el.tagName) || ['UL', 'OL', 'TABLE', 'PRE', 'BLOCKQUOTE', 'HR', 'LI'].includes(el.tagName))
        return '\n' + block(el, o, 0) + '\n';
      return kids();
  }
}

/** Real data tables (with headers or several filled columns) vs tables used for page layout. */
function isDataTable(t: HTMLTableElement): boolean {
  if (t.querySelector('table') || t.getAttribute('role') === 'presentation') return false;
  const rows = Array.from(t.rows ?? []);
  if (!rows.length) return false;
  if (t.querySelector('th')) return true;
  let filled = 0;
  const sample = rows.slice(0, 20);
  for (const r of sample) if (Array.from(r.cells).filter((c) => (c.textContent || '').trim()).length >= 2) filled++;
  return rows.length >= 2 && filled / sample.length >= 0.6;
}

function tableToMd(table: HTMLTableElement, o: Opts): string {
  const rows = Array.from(table.rows ?? []).slice(0, 60);
  if (!rows.length) return '';
  const cells = rows.map((r) =>
    Array.from(r.cells)
      .slice(0, 10)
      .map((c) => inline(c, o).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()),
  );
  const width = Math.max(...cells.map((c) => c.length));
  if (width === 1) return cells.map((c) => c[0]).filter(Boolean).join('\n');
  const pad = (c: string[]) => [...c, ...Array(width - c.length).fill('')];
  const lines = [`| ${pad(cells[0]).join(' | ')} |`, `|${' --- |'.repeat(width)}`];
  for (const c of cells.slice(1)) lines.push(`| ${pad(c).join(' | ')} |`);
  if ((table.rows?.length ?? 0) > 60) lines.push(`(+${table.rows.length - 60} more rows)`);
  return lines.join('\n');
}

function layoutTable(table: HTMLTableElement, o: Opts, depth: number): string {
  const parts: string[] = [];
  for (const r of Array.from(table.rows ?? [])) {
    if (isHidden(r, o)) continue;
    const row = Array.from(r.cells)
      .map((c) => blockChildren(c, o, depth).trim())
      .filter(Boolean);
    if (row.length) parts.push(row.join('  ·  '));
  }
  return parts.join('\n\n');
}

function block(el: Element, o: Opts, depth: number): string {
  if (SKIP.has(el.tagName) || isHidden(el, o)) return '';
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) {
    const t = inlineChildren(el, o).trim();
    return t ? `${'#'.repeat(Number(tag[1]))} ${t}` : '';
  }
  switch (tag) {
    case 'HR':
      return '---';
    case 'PRE':
      return '```\n' + (el.textContent || '').replace(/\n+$/, '') + '\n```';
    case 'BLOCKQUOTE':
      return blockChildren(el, o, depth)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'UL':
    case 'OL': {
      let i = 1;
      const items: string[] = [];
      for (const li of Array.from(el.children)) {
        if (li.tagName !== 'LI' || isHidden(li, o)) continue;
        const marker = tag === 'OL' ? `${i++}.` : '-';
        const body = blockChildren(li, o, depth + 1).trim();
        if (!body) continue;
        const [first, ...rest] = body.split('\n');
        items.push(`${'  '.repeat(depth)}${marker} ${first}${rest.length ? '\n' + rest.map((l) => '  '.repeat(depth + 1) + l.trimStart()).join('\n') : ''}`);
      }
      return items.join('\n');
    }
    case 'TABLE':
      return isDataTable(el as HTMLTableElement) ? tableToMd(el as HTMLTableElement, o) : layoutTable(el as HTMLTableElement, o, depth);
    default:
      return blockChildren(el, o, depth);
  }
}

function inlineChildren(el: Element, o: Opts): string {
  return Array.from(el.childNodes)
    .map((n) => inline(n, o))
    .join('')
    .replace(/[ \t]+/g, ' ');
}

function blockChildren(el: Element, o: Opts, depth: number): string {
  const parts: string[] = [];
  let buf = '';
  const flush = () => {
    const t = buf.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
    if (t) parts.push(t);
    buf = '';
  };
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 1) {
      const c = n as Element;
      if (BLOCK.has(c.tagName) || /^H[1-6]$/.test(c.tagName) || ['UL', 'OL', 'TABLE', 'PRE', 'BLOCKQUOTE', 'HR'].includes(c.tagName)) {
        flush();
        const b = block(c, o, depth);
        if (b.trim()) parts.push(b);
        continue;
      }
    }
    buf += inline(n, o);
  }
  flush();
  return parts.join('\n\n');
}

function tidy(md: string): string {
  // collapse whitespace outside code blocks only
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part) =>
      part.startsWith('```')
        ? part
        : part
            .replace(/\n{3,}/g, '\n\n')
            .replace(/ +\n/g, '\n')
            .replace(/\*\* +\*\*/g, '')
            .replace(/ {2,}/g, ' '),
    )
    .join('')
    .trim();
}

export function htmlToMarkdown(root: Element, live: boolean, links = false): string {
  return tidy(blockChildren(root, { live, baseURI: document.baseURI, links }, 0));
}

/** Article signals: og:type, JSON-LD Article types, or an <article> that holds most of the text. */
function looksLikeArticle(): boolean {
  const og = document.querySelector('meta[property="og:type"]')?.getAttribute('content')?.toLowerCase() ?? '';
  if (og === 'article' || og.startsWith('article')) return true;
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 5)) {
    if (/"@type"\s*:\s*"(News|Blog|Tech|Scholarly)?(Article|Posting|Report)"/i.test(s.textContent ?? '')) return true;
  }
  const art = document.querySelector('article');
  const bodyLen = (document.body?.innerText ?? '').length;
  if (art && bodyLen && ((art as HTMLElement).innerText ?? '').length / bodyLen > 0.5) return true;
  return false;
}

export function readPage(p: ReadParams): ReadResult {
  const base: ReadResult = { url: location.href, title: document.title, markdown: '' };
  if (p.mode === 'article' && looksLikeArticle()) {
    try {
      const clone = document.cloneNode(true) as Document;
      clone.getElementById(OVERLAY_ID)?.remove();
      const article = new Readability(clone, { charThreshold: 300, keepClasses: false }).parse();
      const articleLen = article?.textContent?.trim().length ?? 0;
      const pageLen = (document.body?.innerText ?? '').trim().length;
      // Pages without one main article (threads, listings, dashboards): Readability keeps a fragment.
      const fragment = pageLen > 0 && articleLen / pageLen < 0.35 && pageLen < 80000;
      if (article && article.content && articleLen > 200 && !fragment) {
        const holder = document.createElement('div');
        try {
          holder.innerHTML = article.content;
        } catch {
          // Trusted Types: fall back to DOMParser
          const doc = new DOMParser().parseFromString(article.content, 'text/html');
          holder.append(...Array.from(doc.body.childNodes));
        }
        base.markdown = htmlToMarkdown(holder, false, p.links);
        base.title = article.title || base.title;
        base.byline = article.byline || undefined;
        base.siteName = article.siteName || undefined;
      }
    } catch {
      /* fall through to full */
    }
  }
  if (!base.markdown) {
    const root = document.querySelector('main, [role=main], article') ?? document.body;
    const md = root ? htmlToMarkdown(root, true, p.links) : '';
    // if main is tiny, use the whole body
    base.markdown = md.length < 400 && document.body && root !== document.body ? htmlToMarkdown(document.body, true, p.links) : md;
    if (p.mode === 'full' && document.body && root !== document.body) base.markdown = htmlToMarkdown(document.body, true, p.links);
  }
  return base;
}
