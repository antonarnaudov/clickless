// A provider-neutral chat format. Each provider converts it to its own wire format.

import type { ImageData, JSONSchema } from '../../contracts';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  /** Set when the model's arguments could not be parsed or failed validation; the tool is not run. */
  invalid?: string;
  /** The raw argument text, for the INVALID_JSON error result. */
  rawArgs?: string;
}

export type UserPart = { type: 'text'; text: string } | { type: 'image'; image: ImageData };

export interface ToolResultPart {
  id: string;
  name: string;
  text: string;
  images?: ImageData[];
  isError?: boolean;
}

export type Message =
  | { role: 'user'; content: UserPart[] }
  | {
      role: 'assistant';
      text: string;
      toolCalls: ToolCall[];
      /** Provider-native assistant content, replayed unchanged to the same provider (thinking blocks). */
      raw?: unknown;
      rawProvider?: string;
    }
  | { role: 'tool'; results: ToolResultPart[] };

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal';

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  maxTokens?: number;
  /** Lower effort / cheaper settings for small utility calls (tests, organizer). */
  quick?: boolean;
  onText?(delta: string): void;
  onToolCallStart?(name: string): void;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  /** Provider-native assistant content to store in history. */
  raw?: unknown;
  rawProvider?: string;
  /** Explanation when stopReason is 'refusal'. */
  refusal?: string;
  model?: string;
}

export interface ChatProvider {
  readonly kind: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<string[]>;
}

/** Error with a message that is safe and useful to show the user. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class AbortedError extends Error {
  constructor() {
    super('Stopped');
    this.name = 'AbortError';
  }
}

export function isAbort(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const err = e as { name?: string } | null;
  return !!err && (err.name === 'AbortError' || err.name === 'APIUserAbortError');
}
