// Clickless's AI layer: the agent panel, AI search, the tab organizer and provider utilities.
// Everything it needs from the browser comes through AIDeps, so this module has no Electron imports.

import type { AI, AIDeps, CreateAI } from '../contracts';
import { createAgent } from './agent';
import { createAsk } from './ask';
import { organize } from './organize';
import { ClaudeCodeProvider } from './providers/claude-code';
import { makeProvider, providerLabel } from './providers';
import { search } from './search';

export const createAI: CreateAI = (deps: AIDeps): AI => {
  const agent = createAgent(deps);
  const ask = createAsk(deps);

  const findProvider = (id: string) => deps.settings().providers.find((p) => p.id === id);

  return {
    agent,
    ask,
    search: (query, opts) => search(deps, query, opts),
    organize: (spaceId) => organize(deps, spaceId),

    async testProvider(providerId) {
      const config = findProvider(providerId);
      if (!config) return { ok: false, message: 'Unknown provider.' };
      const t0 = Date.now();
      try {
        if (config.kind === 'claude-code') {
          const v = await new ClaudeCodeProvider(config).version();
          const control = deps.control();
          return {
            ok: true,
            message: `Found ${v || 'Claude Code'}.${control ? '' : ' Turn on the local control API (Settings → Agents) so it can drive the browser.'}`,
            ms: Date.now() - t0,
          };
        }
        const provider = makeProvider(config, deps.getSecret(config.id));
        const res = await provider.chat({
          system: 'You are a connection test. Reply with the single word OK.',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          maxTokens: 512,
          quick: true,
          signal: AbortSignal.timeout(30000),
        });
        const ms = Date.now() - t0;
        const said = res.text.trim().slice(0, 40);
        return { ok: true, message: `Connected to ${res.model ?? config.model} in ${ms} ms${said ? ` (replied “${said}”)` : ''}.`, ms };
      } catch (e) {
        const err = e as Error;
        const msg = err.name === 'TimeoutError' ? 'No reply within 30 s.' : err.message || String(e);
        return { ok: false, message: msg, ms: Date.now() - t0 };
      }
    },

    async listModels(providerId) {
      const config = findProvider(providerId);
      if (!config) return [];
      return makeProvider(config, deps.getSecret(config.id)).listModels();
    },

    providerLabel,
  };
};

export { AGENT_SYSTEM, summarizeCall } from './agent';
export { ASK_SYSTEM } from './ask';
