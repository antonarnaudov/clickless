import { memo } from 'react';
import { Globe, Plug, Server, Sparkles, Terminal, type LucideIcon } from 'lucide-react';
import { BRAND_ICONS } from './brand-icons';
import { cx } from './util';

const GENERIC: Record<string, LucideIcon> = { custom: Server, http: Globe, cli: Terminal, clickless: Sparkles, plug: Plug };

/**
 * A provider or agent logo on a soft tile. Brand logos come from lobe-icons (MIT); anything else
 * gets a generic line icon.
 */
export const BrandIcon = memo(function BrandIcon({ name, size = 18, tile = 30, className }: { name?: string; size?: number; tile?: number | false; className?: string }) {
  const svg = name ? (BRAND_ICONS as Record<string, string>)[name] : undefined;
  const Generic = !svg ? (GENERIC[name ?? ''] ?? Plug) : null;
  const inner = svg ? <span className="brand-svg" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} /> : Generic ? <Generic size={size} strokeWidth={1.8} /> : null;
  if (tile === false) return <span className={cx('brand-icon bare', className)}>{inner}</span>;
  return (
    <span className={cx('brand-icon', className)} style={{ width: tile, height: tile }}>
      {inner}
    </span>
  );
});

/** Brand key for a provider preset. */
export const PROVIDER_BRAND: Record<string, string> = {
  anthropic: 'anthropic',
  'claude-code': 'claude-code',
  openai: 'openai',
  openrouter: 'openrouter',
  gemini: 'gemini',
  ollama: 'ollama',
  lmstudio: 'lmstudio',
  groq: 'groq',
  deepseek: 'deepseek',
  mistral: 'mistral',
  custom: 'custom',
};

/** Best guess for a saved provider (by its base URL / label) when its preset isn't known. */
export function providerBrand(p: { kind: string; label: string; baseURL?: string }): string {
  if (p.kind === 'anthropic') return 'anthropic';
  if (p.kind === 'claude-code') return 'claude-code';
  const s = `${p.label} ${p.baseURL ?? ''}`.toLowerCase();
  for (const [k, re] of [
    ['openrouter', /openrouter/],
    ['ollama', /ollama|:11434/],
    ['lmstudio', /lm ?studio|:1234/],
    ['gemini', /gemini|generativelanguage|googleapis/],
    ['groq', /groq/],
    ['deepseek', /deepseek/],
    ['mistral', /mistral/],
    ['openai', /openai/],
  ] as const)
    if (re.test(s)) return k;
  return 'custom';
}
