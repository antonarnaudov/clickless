import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true });

// Every link opens in an Clickless tab; the click handler reads data-href.
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const tok = tokens[idx];
  const href = tok.attrGet('href') ?? '';
  // No real href: a click must never navigate the UI surface itself.
  tok.attrs = (tok.attrs ?? []).filter(([k]) => k !== 'href');
  tok.attrSet('data-href', href);
  tok.attrSet('title', href);
  tok.attrSet('role', 'link');
  tok.attrSet('tabindex', '0');
  return defaultLink(tokens, idx, options, env, self);
};

export function renderMarkdown(src: string): string {
  return md.render(src ?? '');
}

/**
 * Markdown with [n] / [1, 2] / [1][2] citations turned into chips. Code blocks are left alone.
 * `max` limits citation numbers to existing sources.
 */
export function renderCited(src: string, max: number): string {
  const html = md.render(src ?? '');
  return html
    .split(/(<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>|<[^>]+>)/g)
    .map((part) => {
      if (part.startsWith('<')) return part;
      return part.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g, (m, nums: string) => {
        const ns = nums.split(',').map((x) => Number(x.trim())).filter((n) => n >= 1 && (max === 0 || n <= max));
        if (!ns.length) return m;
        return ns.map((n) => `<span class="cite" data-cite="${n}">${n}</span>`).join('');
      });
    })
    .join('')
    .replace(/((?:<span class="cite" data-cite="\d+">\d+<\/span>)+)/g, '<span class="cites">$1</span>');
}

/** Delegated click handler for rendered markdown: returns the URL a link points to, if any. */
export function linkFromEvent(e: React.MouseEvent): string | null {
  const a = (e.target as HTMLElement).closest('a[data-href]') as HTMLAnchorElement | null;
  if (!a) return null;
  e.preventDefault();
  return a.dataset.href ?? null;
}
