// Claude through the official Anthropic SDK (streaming, adaptive thinking, eager tool input streaming,
// server-side refusal fallbacks). History is append-only: assistant content (including thinking blocks)
// is replayed exactly as received.

import Anthropic from '@anthropic-ai/sdk';
import type { ProviderConfig } from '../../../shared/types';
import { coerceArgs, validateArgs } from '../util';
import {
  AbortedError,
  ProviderError,
  isAbort,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type Message,
  type ToolCall,
  type ToolSpec,
} from './types';

type Block = Anthropic.Beta.BetaContentBlock;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** Models that take `thinking: {type: "adaptive"}` and `output_config.effort`. */
function isModern(model: string): boolean {
  return /claude-(fable|mythos|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-6|haiku-5)/.test(model);
}

/** Models where server-side refusal fallbacks ("default") are recommended. */
function supportsFallbacks(model: string): boolean {
  return /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(model);
}

function isFirstParty(baseURL?: string): boolean {
  if (!baseURL) return true;
  try {
    return new URL(baseURL).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

function toAnthropicTools(tools: ToolSpec[] | undefined): Anthropic.Beta.BetaTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { type: 'object', ...(t.inputSchema as object) } as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
}

function toAnthropicMessages(messages: Message[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content: BlockParam[] = [];
      for (const p of m.content) {
        if (p.type === 'text') {
          if (p.text) content.push({ type: 'text', text: p.text });
        } else content.push({ type: 'image', source: { type: 'base64', media_type: p.image.mimeType, data: p.image.data } });
      }
      if (content.length) out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      if (m.rawProvider === 'anthropic' && Array.isArray(m.raw) && m.raw.length) {
        out.push({ role: 'assistant', content: m.raw as BlockParam[] });
        continue;
      }
      const content: BlockParam[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: safeId(c.id), name: c.name, input: c.args });
      if (content.length) out.push({ role: 'assistant', content });
    } else {
      const content: BlockParam[] = m.results.map((r) => {
        const parts: (Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam)[] = [];
        parts.push({ type: 'text', text: r.text || (r.isError ? 'Error' : 'OK') });
        for (const img of r.images ?? []) parts.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } });
        return { type: 'tool_result', tool_use_id: safeId(r.id), content: parts, ...(r.isError ? { is_error: true } : {}) };
      });
      if (content.length) out.push({ role: 'user', content });
    }
  }
  return out;
}

/** Anthropic tool ids must match ^[a-zA-Z0-9_-]+$ (ids from other providers may not). */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
}

/**
 * After a mid-output fallback the blocks before the last `fallback` block belong to a model that
 * declined: drop its thinking / tool_use blocks (text stays) before echoing the turn back.
 */
function echoableContent(blocks: Block[]): Block[] {
  const last = blocks.map((b) => b.type).lastIndexOf('fallback');
  if (last < 0) return blocks;
  const before = blocks.slice(0, last).filter((b) => b.type === 'text');
  return [...before, ...blocks.slice(last + 1)];
}

function friendlyError(e: unknown, model: string): Error {
  if (e instanceof Anthropic.AuthenticationError) return new ProviderError('Anthropic rejected the API key (401). Check it in Settings → AI.');
  if (e instanceof Anthropic.PermissionDeniedError) return new ProviderError(`This API key may not use ${model} (403).`);
  if (e instanceof Anthropic.NotFoundError) return new ProviderError(`Model “${model}” was not found (404). Pick another model in Settings → AI.`);
  if (e instanceof Anthropic.RateLimitError) return new ProviderError('Anthropic rate limit reached (429). Try again in a moment.', true);
  if (e instanceof Anthropic.InternalServerError) return new ProviderError(`Anthropic is having trouble (${e.status}). Try again shortly.`, true);
  if (e instanceof Anthropic.BadRequestError) return new ProviderError(`Anthropic refused the request: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('Can’t reach the Anthropic API. Check your connection.', true);
  if (e instanceof Anthropic.APIError) return new ProviderError(`Anthropic error ${e.status ?? ''}: ${e.message}`.trim());
  if (e instanceof Anthropic.AnthropicError && /auth|api.?key|credential/i.test(e.message))
    return new ProviderError('No Anthropic API key. Add one in Settings → AI (or sign in with `ant auth login`).');
  return e instanceof Error ? e : new Error(String(e));
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = 'anthropic';
  private client: Anthropic;
  private model: string;

  constructor(
    private config: ProviderConfig,
    apiKey: string | undefined,
  ) {
    this.model = config.model?.trim() || DEFAULT_ANTHROPIC_MODEL;
    this.client = new Anthropic({
      // No stored key: let the SDK resolve ANTHROPIC_API_KEY / an `ant auth login` profile.
      ...(apiKey ? { apiKey } : {}),
      baseURL: config.baseURL?.trim() || undefined,
      maxRetries: 2,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = this.model;
    const modern = isModern(model);
    const fallbacks = supportsFallbacks(model) && isFirstParty(this.config.baseURL);
    const tools = toAnthropicTools(req.tools);
    const params: StreamParams = {
      model,
      max_tokens: req.maxTokens ?? 32000,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      // Caches the stable prefix (tools + system + earlier turns) across agent steps.
      cache_control: { type: 'ephemeral' },
      ...(tools ? { tools } : {}),
      ...(modern ? { thinking: { type: 'adaptive' }, output_config: { effort: req.quick ? 'low' : (this.config.effort ?? 'medium') } } : {}),
      ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    };

    let message: Anthropic.Beta.BetaMessage | undefined;
    for (let attempt = 0; ; attempt++) {
      if (req.signal?.aborted) throw new AbortedError();
      const stream = this.client.beta.messages.stream(params, { signal: req.signal });
      if (req.onText) stream.on('text', (delta) => req.onText!(delta));
      if (req.onToolCallStart)
        stream.on('streamEvent', (ev) => {
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') req.onToolCallStart!(ev.content_block.name);
        });
      try {
        message = await stream.finalMessage();
        break;
      } catch (e) {
        if (isAbort(e, req.signal)) throw new AbortedError();
        // With eager input streaming, a tool input that is not parseable JSON rejects here
        // with a non-API error: re-issue the turn (capped).
        const jsonError = !(e instanceof Anthropic.APIError) && (e instanceof SyntaxError || /JSON/i.test((e as Error)?.message ?? ''));
        if (jsonError && attempt < 2) continue;
        throw friendlyError(e, model);
      }
    }

    if (message.stop_reason === 'refusal') {
      const d = message.stop_details;
      const text = textOf(echoableContent(message.content));
      return {
        text,
        toolCalls: [],
        stopReason: 'refusal',
        refusal: d?.explanation || `The model declined this request${d?.category ? ` (${d.category})` : ''}.`,
        model: message.model,
      };
    }

    const content = echoableContent(message.content);
    const toolCalls: ToolCall[] = [];
    const specs = new Map((req.tools ?? []).map((t) => [t.name, t]));
    for (const b of content) {
      if (b.type !== 'tool_use') continue;
      const spec = specs.get(b.name);
      const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
      const args = coerceArgs(spec?.inputSchema, input) as Record<string, any>;
      const err = !spec ? `unknown tool "${b.name}"` : validateArgs(spec.inputSchema, args);
      toolCalls.push({ id: b.id, name: b.name, args, ...(err ? { invalid: err, rawArgs: JSON.stringify(b.input) } : {}) });
    }

    if (message.stop_reason === 'max_tokens' && toolCalls.length) {
      // A truncated tool input can still look valid: never run it.
      for (const c of toolCalls) c.invalid = 'tool input was cut off (max_tokens); send a shorter call';
    }

    return {
      text: textOf(content),
      toolCalls,
      stopReason: toolCalls.length ? 'tool_use' : message.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
      raw: content,
      rawProvider: 'anthropic',
      model: message.model,
    };
  }

  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = [];
      for await (const m of this.client.models.list()) ids.push(m.id);
      return ids;
    } catch (e) {
      throw friendlyError(e, this.model);
    }
  }
}

function textOf(blocks: Block[]): string {
  return blocks
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}
