import type { ProviderConfig, Settings } from '../../../shared/types';
import { AnthropicProvider } from './anthropic';
import { ClaudeCodeProvider } from './claude-code';
import { OpenAICompatProvider } from './openai';
import type { ChatProvider } from './types';

export function makeProvider(config: ProviderConfig, apiKey: string | undefined): ChatProvider {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicProvider(config, apiKey);
    case 'claude-code':
      return new ClaudeCodeProvider(config);
    case 'openai':
    default:
      return new OpenAICompatProvider(config, apiKey);
  }
}

/** Provider for the agent panel: the chosen one, else the first configured. */
export function agentProvider(s: Settings): ProviderConfig | undefined {
  return s.providers.find((p) => p.id === s.agentProviderId) ?? s.providers[0];
}

/** Provider for AI search and organizing: ask provider → agent provider → first. */
export function askProvider(s: Settings): ProviderConfig | undefined {
  return s.providers.find((p) => p.id === s.askProviderId) ?? agentProvider(s);
}

const FAMILY: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', mythos: 'Mythos' };

/** "claude-opus-5-5" → "Claude Opus 5.5"; null when it's not a Claude model id. */
export function claudeName(model: string): string | null {
  const m = model.match(/(?:^|\/)claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:[-.](\d{1,2}))?(?![\d])/i);
  if (!m) return null;
  return `Claude ${FAMILY[m[1].toLowerCase()]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

export function providerLabel(p: ProviderConfig | undefined): string | null {
  if (!p) return null;
  const model = p.model?.trim() ?? '';
  if (p.kind === 'claude-code') {
    if (!model || model === 'default') return 'Claude Code';
    return `${claudeName(model) ?? model} · Claude Code`;
  }
  const name = claudeName(model);
  return `${name ?? (model || 'model')} · ${p.label || p.kind}`;
}

export * from './types';
