// Tidy a space: group Today tabs into folders, close duplicates, shorten noisy titles.

import type { AIDeps } from '../contracts';
import type { OrganizeProposal, Tab } from '../../shared/types';
import { askProvider, makeProvider } from './providers';
import { extractJson, hostOf, normalizeUrl, truncate } from './util';

const ORGANIZE_SYSTEM = `You organize browser tabs into folders. Reply with JSON only, no prose:
{"groups":[{"name":"Short folder name","emoji":"🧪","tabIds":["id1","id2"]}],"renames":[{"tabId":"id","title":"Short title"}]}
Rules: group by topic or task (not only by website); 2–6 groups; every group has at least 2 tabs; a tab is in at most one group; leave tabs that fit nowhere out; folder names are 1–3 words; rename only titles that are long or noisy (max 40 characters, keep the meaning); use only the tab ids given.`;

const SITE_NAMES: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'youtube.com': 'YouTube',
  'google.com': 'Google',
  'docs.google.com': 'Google Docs',
  'mail.google.com': 'Gmail',
  'stackoverflow.com': 'Stack Overflow',
  'reddit.com': 'Reddit',
  'x.com': 'X',
  'twitter.com': 'X',
  'linkedin.com': 'LinkedIn',
  'notion.so': 'Notion',
  'figma.com': 'Figma',
  'amazon.com': 'Amazon',
  'wikipedia.org': 'Wikipedia',
  'news.ycombinator.com': 'Hacker News',
  'npmjs.com': 'npm',
  'vercel.com': 'Vercel',
  'chatgpt.com': 'ChatGPT',
  'claude.ai': 'Claude',
};

const SITE_EMOJI: Record<string, string> = {
  GitHub: '🐙',
  GitLab: '🦊',
  YouTube: '📺',
  Google: '🔎',
  'Google Docs': '📄',
  Gmail: '✉️',
  'Stack Overflow': '🧩',
  Reddit: '👽',
  X: '✖️',
  LinkedIn: '💼',
  Notion: '📓',
  Figma: '🎨',
  Amazon: '📦',
  Wikipedia: '📚',
  'Hacker News': '📰',
  npm: '📦',
  Vercel: '▲',
  ChatGPT: '💬',
  Claude: '✳️',
};

/** "app.docs.example.co.uk" → "example.co.uk"; known multi-part hosts are kept. */
export function siteKey(url: string): string {
  const host = hostOf(url);
  if (!host) return '';
  if (SITE_NAMES[host]) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  if (tld.length === 2 && ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'].includes(sld)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

function siteName(key: string): string {
  if (SITE_NAMES[key]) return SITE_NAMES[key];
  const label = key.split('.')[0] ?? key;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function candidates(deps: AIDeps, spaceId: string): Tab[] {
  return deps.browser.listTabs({ spaceId }).filter((t) => t.spaceId === spaceId && !t.pinned && !t.favorite);
}

/** Same URL twice: keep the most recently used one. */
function duplicates(tabs: Tab[]): string[] {
  const byUrl = new Map<string, Tab[]>();
  for (const t of tabs) {
    const k = normalizeUrl(t.url);
    byUrl.set(k, [...(byUrl.get(k) ?? []), t]);
  }
  const close: string[] = [];
  for (const list of byUrl.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    close.push(...list.slice(1).map((t) => t.id));
  }
  return close;
}

export function heuristicProposal(spaceId: string, tabs: Tab[]): OrganizeProposal {
  const close = duplicates(tabs);
  const closing = new Set(close);
  const bySite = new Map<string, Tab[]>();
  for (const t of tabs) {
    if (closing.has(t.id) || t.internal) continue;
    const k = siteKey(t.url);
    if (!k) continue;
    bySite.set(k, [...(bySite.get(k) ?? []), t]);
  }
  const groups = [...bySite.entries()]
    .filter(([, list]) => list.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, list]) => {
      const name = siteName(k);
      return { name, emoji: SITE_EMOJI[name] ?? '🗂️', tabIds: list.sort((a, b) => a.order - b.order).map((t) => t.id) };
    });
  return { spaceId, groups, close, renames: [], source: 'heuristic' };
}

/** Keeps only valid ids, one group per tab, groups of 2+, sane names. */
export function sanitizeProposal(spaceId: string, tabs: Tab[], raw: any, close: string[]): OrganizeProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const valid = new Set(tabs.map((t) => t.id));
  const closing = new Set(close);
  const used = new Set<string>();
  const groups: OrganizeProposal['groups'] = [];
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    if (!g || typeof g !== 'object') continue;
    const ids: string[] = (Array.isArray(g.tabIds) ? g.tabIds : Array.isArray(g.tabs) ? g.tabs : [])
      .map((x: unknown) => String(x))
      .filter((id: string) => valid.has(id) && !used.has(id) && !closing.has(id));
    if (ids.length < 2) continue;
    ids.forEach((id) => used.add(id));
    const name = truncate(String(g.name ?? 'Group').trim() || 'Group', 32);
    const emoji = typeof g.emoji === 'string' && g.emoji.trim() ? [...g.emoji.trim()].slice(0, 2).join('') : undefined;
    groups.push({ name, ...(emoji ? { emoji } : {}), tabIds: ids });
  }
  const renames: OrganizeProposal['renames'] = [];
  for (const r of Array.isArray(raw.renames) ? raw.renames : []) {
    const id = String(r?.tabId ?? r?.id ?? '');
    const title = String(r?.title ?? '').trim();
    if (!valid.has(id) || !title || closing.has(id)) continue;
    const tab = tabs.find((t) => t.id === id)!;
    if (title === tab.title) continue;
    renames.push({ tabId: id, title: truncate(title, 40) });
  }
  if (!groups.length && !renames.length) return null;
  return { spaceId, groups, close, renames, source: 'ai' };
}

export async function organize(deps: AIDeps, spaceId: string, signal?: AbortSignal): Promise<OrganizeProposal> {
  const tabs = candidates(deps, spaceId);
  const close = duplicates(tabs);
  if (tabs.length < 2) return { spaceId, groups: [], close, renames: [], source: 'heuristic' };
  const config = askProvider(deps.settings());
  if (!config) return heuristicProposal(spaceId, tabs);
  const closing = new Set(close);
  const list = tabs
    .filter((t) => !closing.has(t.id) && !t.internal)
    .map((t) => `${t.id} | ${truncate(t.title || 'Untitled', 90)} | ${truncate(t.url, 120)}`)
    .join('\n');
  try {
    const provider = makeProvider(config, deps.getSecret(config.id));
    const res = await provider.chat({
      system: ORGANIZE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Tabs (id | title | url):\n${list}` }] }],
      maxTokens: 4000,
      quick: true,
      signal,
    });
    const proposal = sanitizeProposal(spaceId, tabs, extractJson(res.text), close);
    if (proposal) return proposal;
  } catch {
    // fall through to the heuristic
  }
  return heuristicProposal(spaceId, tabs);
}
