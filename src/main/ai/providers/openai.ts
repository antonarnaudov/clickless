// Any OpenAI-compatible /chat/completions server: OpenAI, OpenRouter, Gemini's OpenAI endpoint,
// Ollama, LM Studio, Groq, vLLM, llama.cpp, LiteLLM, DeepSeek, Together…
// Streaming with tool-call deltas, with fallbacks for servers that do less.

import type { ProviderConfig } from '../../../shared/types';
import { coerceArgs, parseTextToolCalls, stripThinking, uid, validateArgs } from '../util';
import {
  AbortedError,
  ProviderError,
  isAbort,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type Message,
  type ToolCall,
} from './types';

interface OAToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type OAContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

type OAMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OAContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OAToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Qwen 3 models think at length before every tool call; on a laptop that is ~45 s per browser step.
 * Their soft switch `/no_think` keeps answers as good for browsing and halves the time per step
 * (measured with qwen3.8-27b in LM Studio: 23 s → 10 s). Models named "*thinking*" are left alone.
 */
export function fastThinking(model: string, system: string): string {
  if (/qwen-?3/i.test(model) && !/thinking/i.test(model) && !system.includes('/no_think')) return `${system}\n\n/no_think`;
  return system;
}

export function toOpenAIMessages(system: string, messages: Message[], vision: boolean): OAMessage[] {
  const out: OAMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      const texts = m.content.filter((p) => p.type === 'text') as { type: 'text'; text: string }[];
      const images = vision ? m.content.filter((p) => p.type === 'image') : [];
      if (!images.length) out.push({ role: 'user', content: texts.map((t) => t.text).join('\n\n') });
      else
        out.push({
          role: 'user',
          content: [
            ...texts.map((t) => ({ type: 'text' as const, text: t.text })),
            ...images.map((p) => ({ type: 'image_url' as const, image_url: { url: `data:${(p as any).image.mimeType};base64,${(p as any).image.data}` } })),
          ],
        });
    } else if (m.role === 'assistant') {
      const msg: OAMessage = { role: 'assistant', content: m.text || (m.toolCalls.length ? null : '') };
      if (m.toolCalls.length)
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args) } }));
      out.push(msg);
    } else {
      const imgs: OAContentPart[] = [];
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.text || (r.isError ? 'Error' : 'OK') });
        if (vision) for (const img of r.images ?? []) imgs.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
      }
      // Tool messages can't carry images: send them in a user message right after.
      if (imgs.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot returned by the tool call above:' }, ...imgs] });
    }
  }
  return out;
}

export class OpenAICompatProvider implements ChatProvider {
  readonly kind = 'openai';
  private base: string;

  constructor(
    private config: ProviderConfig,
    private apiKey: string | undefined,
  ) {
    this.base = (config.baseURL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (/openrouter\.ai/.test(this.base)) {
      h['HTTP-Referer'] = 'https://github.com/antonarnaudov/clickless';
      h['X-Title'] = 'Clickless';
    }
    return h;
  }

  private label(): string {
    return this.config.label || 'the model server';
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    } catch (e) {
      if (isAbort(e, signal)) throw new AbortedError();
      const local = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(this.base);
      throw new ProviderError(
        local
          ? `Can’t reach ${this.label()} at ${this.base}. Is it running? (${(e as Error).message})`
          : `Can’t reach ${this.label()} (${(e as Error).message}).`,
        true,
      );
    }
    return res;
  }

  private async errorFrom(res: Response): Promise<ProviderError> {
    let detail = '';
    try {
      const t = await res.text();
      try {
        const j = JSON.parse(t);
        detail = j?.error?.message ?? j?.message ?? j?.detail ?? t;
      } catch {
        detail = t;
      }
    } catch {
      /* ignore */
    }
    detail = String(detail).slice(0, 300);
    if (res.status === 401 || res.status === 403) return new ProviderError(`${this.label()} rejected the API key (${res.status}). ${detail}`.trim());
    if (res.status === 404) return new ProviderError(`${this.label()}: model “${this.config.model}” or endpoint not found (404). ${detail}`.trim());
    if (res.status === 429) return new ProviderError(`${this.label()} rate limit reached (429). ${detail}`.trim(), true);
    if (res.status >= 500) return new ProviderError(`${this.label()} server error ${res.status}. ${detail}`.trim(), true);
    return new ProviderError(`${this.label()} error ${res.status}: ${detail}`);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const tools = req.tools?.length
      ? req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', ...t.inputSchema } } }))
      : undefined;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toOpenAIMessages(fastThinking(this.config.model, req.system), req.messages, this.config.vision),
      ...(tools ? { tools } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    };

    let res = await this.post({ ...body, stream: true }, req.signal);
    if (!res.ok && res.status === 400) {
      // Some servers reject streaming together with tools: retry without streaming.
      const err = await this.errorFrom(res);
      if (/stream/i.test(err.message) || tools) {
        res = await this.post(body, req.signal);
        if (!res.ok) throw await this.errorFrom(res);
        return this.finish(await this.parseJson(res, req), req);
      }
      throw err;
    }
    if (!res.ok) throw await this.errorFrom(res);

    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('text/event-stream') && !ctype.includes('stream')) {
      // Server ignored stream: true.
      return this.finish(await this.parseJson(res, req), req);
    }
    return this.finish(await this.parseStream(res, req), req);
  }

  private async parseJson(res: Response, req: ChatRequest): Promise<Partial0> {
    let j: any;
    try {
      j = await res.json();
    } catch (e) {
      if (isAbort(e, req.signal)) throw new AbortedError();
      throw new ProviderError(`${this.label()} returned a response that is not JSON.`);
    }
    const choice = j?.choices?.[0];
    const msg = choice?.message ?? {};
    const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => p?.text ?? '').join('') : '';
    if (text && req.onText) req.onText(stripThinking(text));
    const calls = (msg.tool_calls ?? []).map((c: any) => ({ id: c.id || uid('call'), name: c.function?.name ?? '', args: c.function?.arguments ?? '' }));
    return { text, calls, finish: choice?.finish_reason ?? null, model: j?.model };
  }

  private async parseStream(res: Response, req: ChatRequest): Promise<Partial0> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let finish: string | null = null;
    let model: string | undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let visibleSent = 0;
    const emitText = () => {
      if (!req.onText) return;
      const visible = stripThinking(text);
      // Only emit once we know we're not inside a <think> block or a text-encoded tool call.
      if (/^\s*(<tool_call>|\{\s*"(name|function)")/.test(visible)) return;
      if (visible.length > visibleSent) {
        req.onText(visible.slice(visibleSent));
        visibleSent = visible.length;
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j: any;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          if (j.error) throw new ProviderError(`${this.label()}: ${j.error.message ?? JSON.stringify(j.error)}`);
          model ??= j.model;
          const choice = j.choices?.[0];
          if (!choice) continue;
          const d = choice.delta ?? choice.message ?? {};
          if (typeof d.content === 'string' && d.content) {
            text += d.content;
            emitText();
          }
          for (const tc of d.tool_calls ?? []) {
            const idx: number = typeof tc.index === 'number' ? tc.index : tc.id ? [...calls.values()].findIndex((c) => c.id === tc.id) : calls.size - 1;
            const key = idx >= 0 ? idx : calls.size;
            let cur = calls.get(key);
            if (!cur) {
              cur = { id: tc.id || uid('call'), name: '', args: '' };
              calls.set(key, cur);
            }
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) {
              if (!cur.name && req.onToolCallStart) req.onToolCallStart(tc.function.name);
              cur.name = cur.name && cur.name !== tc.function.name ? cur.name + tc.function.name : tc.function.name;
            }
            if (tc.function?.arguments !== undefined) {
              cur.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
            }
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
    } catch (e) {
      if (isAbort(e, req.signal)) throw new AbortedError();
      throw e;
    }
    return { text, calls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c), finish, model };
  }

  private finish(p: Partial0, req: ChatRequest): ChatResponse {
    const specs = new Map((req.tools ?? []).map((t) => [t.name, t]));
    let text = stripThinking(p.text).trim();
    const toolCalls: ToolCall[] = [];
    for (const c of p.calls) {
      if (!c.name) continue;
      let args: Record<string, any> = {};
      let invalid: string | undefined;
      const raw = typeof c.args === 'string' ? c.args : JSON.stringify(c.args);
      if (typeof c.args === 'string') {
        if (c.args.trim()) {
          try {
            const parsed = JSON.parse(c.args);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
            else invalid = 'arguments must be a JSON object';
          } catch {
            invalid = 'arguments are not valid JSON';
          }
        }
      } else if (c.args && typeof c.args === 'object') args = c.args as Record<string, any>;
      const spec = specs.get(c.name);
      if (!invalid) {
        args = coerceArgs(spec?.inputSchema, args) as Record<string, any>;
        invalid = !spec ? `unknown tool "${c.name}"` : (validateArgs(spec.inputSchema, args) ?? undefined);
      }
      toolCalls.push({ id: c.id, name: c.name, args, ...(invalid ? { invalid, rawArgs: raw } : {}) });
    }
    // Models that write tool calls as text.
    if (!toolCalls.length && specs.size && text) {
      const { calls, rest } = parseTextToolCalls(text, [...specs.keys()]);
      for (const c of calls) {
        const spec = specs.get(c.name)!;
        const args = coerceArgs(spec.inputSchema, c.args) as Record<string, any>;
        const invalid = validateArgs(spec.inputSchema, args) ?? undefined;
        toolCalls.push({ id: uid('call'), name: c.name, args, ...(invalid ? { invalid, rawArgs: JSON.stringify(c.args) } : {}) });
      }
      if (calls.length) text = rest;
    }
    if (p.finish === 'length' && toolCalls.length) for (const c of toolCalls) c.invalid ??= 'tool call was cut off (max tokens); send a shorter call';
    const refused = p.finish === 'content_filter' && !text && !toolCalls.length;
    return {
      text,
      toolCalls,
      stopReason: refused ? 'refusal' : toolCalls.length ? 'tool_use' : p.finish === 'length' ? 'max_tokens' : 'end',
      ...(refused ? { refusal: 'The provider’s content filter blocked this response.' } : {}),
      model: p.model,
    };
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.base}/models`, { headers: this.headers() }).catch((e) => {
      throw new ProviderError(`Can’t reach ${this.label()} at ${this.base} (${(e as Error).message}).`);
    });
    if (!res.ok) throw await this.errorFrom(res);
    const j: any = await res.json();
    const list: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
    return list
      .map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.name ?? '')))
      .map((id: string) => id.replace(/^models\//, ''))
      .filter(Boolean)
      .sort();
  }
}

interface Partial0 {
  text: string;
  calls: { id: string; name: string; args: string | Record<string, unknown> }[];
  finish: string | null;
  model?: string;
}
