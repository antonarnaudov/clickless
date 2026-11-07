// Small helpers shared by the AI modules.

import type { JSONSchema } from '../contracts';

let counter = 0;
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Calls `fn` at most every `ms` while scheduled; `flush` runs it now. */
export function throttle(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  const run = () => {
    timer = null;
    last = Date.now();
    fn();
  };
  return {
    schedule() {
      if (timer) return;
      const wait = Math.max(0, ms - (Date.now() - last));
      timer = setTimeout(run, wait);
    },
    flush() {
      if (timer) clearTimeout(timer);
      run();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
      },
      { once: true },
    );
  });
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

/** Fixes the common ways models get argument types wrong (JSON strings for arrays, "3" for 3). */
function coerceValue(schema: JSONSchema | undefined, v: unknown): unknown {
  if (!schema || v === undefined || v === null) return v;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length) return v;
  const actual = typeOf(v);
  if (types.some((t) => typeMatches(t, actual))) {
    if (actual === 'object' && schema.properties) return coerceArgs(schema, v as Record<string, unknown>);
    if (actual === 'array' && schema.items) return (v as unknown[]).map((x) => coerceValue(schema.items, x));
    return v;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if ((types.includes('array') && s.startsWith('[')) || (types.includes('object') && s.startsWith('{'))) {
      try {
        return coerceValue(schema, JSON.parse(s));
      } catch {
        return v;
      }
    }
    if ((types.includes('number') || types.includes('integer')) && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (types.includes('boolean') && (s === 'true' || s === 'false')) return s === 'true';
  }
  if (types.includes('string') && (typeof v === 'number' || typeof v === 'boolean')) return String(v);
  return v;
}

export function coerceArgs(schema: JSONSchema | undefined, args: Record<string, unknown>): Record<string, unknown> {
  if (!schema?.properties || !args || typeof args !== 'object') return args;
  const out: Record<string, unknown> = { ...args };
  for (const [k, sub] of Object.entries(schema.properties)) {
    if (k in out) out[k] = coerceValue(sub, out[k]);
  }
  return out;
}

/** Lenient schema check: object, required keys, simple types, enums. Returns an error or null. */
export function validateArgs(schema: JSONSchema | undefined, args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be a JSON object';
  if (!schema) return null;
  const a = args as Record<string, unknown>;
  for (const req of schema.required ?? []) {
    if (a[req] === undefined) return `missing required argument "${req}"`;
  }
  for (const [k, sub] of Object.entries(schema.properties ?? {})) {
    const v = a[k];
    if (v === undefined || v === null || !sub) continue;
    if (sub.type !== undefined && !sub.oneOf && !sub.anyOf) {
      const types = Array.isArray(sub.type) ? sub.type : [sub.type];
      const actual = typeOf(v);
      if (!types.some((t) => typeMatches(t, actual))) return `argument "${k}" should be ${types.join(' or ')}, got ${actual}`;
    }
    if (sub.enum && !sub.enum.includes(v)) return `argument "${k}" must be one of ${sub.enum.map((x) => JSON.stringify(x)).join(', ')}`;
  }
  return null;
}

/** Finds the first balanced JSON object or array in text (models wrap JSON in prose or fences). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fence ? [fence[1], text] : [text];
  for (const c of candidates) {
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (ch !== '{' && ch !== '[') continue;
      const end = matchBracket(c, i);
      if (end < 0) continue;
      try {
        return JSON.parse(c.slice(i, end + 1));
      } catch {
        // keep scanning
      }
    }
  }
  return undefined;
}

/** Index of the bracket closing the one at `start`, or -1 (strings and escapes respected). */
function matchBracket(s: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/**
 * Some local models write tool calls as text instead of using the tool-calling API:
 *   {"name": "act", "arguments": {...}}   <tool_call>{...}</tool_call>   ```json {...}```
 * Returns the calls found (only for known tool names) and the text without them.
 */
export function parseTextToolCalls(text: string, toolNames: string[]): { calls: { name: string; args: Record<string, any> }[]; rest: string } {
  const names = new Set(toolNames);
  const calls: { name: string; args: Record<string, any> }[] = [];
  let rest = text;
  const take = (obj: any): boolean => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj;
    const name = fn.name ?? fn.tool ?? fn.tool_name;
    if (typeof name !== 'string' || !names.has(name)) return false;
    let args = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    calls.push({ name, args: args && typeof args === 'object' ? args : {} });
    return true;
  };
  // <tool_call>…</tool_call> (Qwen / Hermes style)
  rest = rest.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (m, inner) => {
    try {
      return take(JSON.parse(inner)) ? '' : m;
    } catch {
      const j = extractJson(inner);
      return take(j) ? '' : m;
    }
  });
  if (calls.length) return { calls, rest: rest.trim() };
  // A bare JSON object (optionally fenced) that is the whole message or most of it.
  const j = extractJson(rest);
  const list = Array.isArray(j) ? j : [j];
  if (list.every((x) => x && typeof x === 'object')) {
    for (const x of list) take(x);
  }
  if (calls.length) {
    rest = rest.replace(/```(?:json)?[\s\S]*?```/gi, '').replace(/\{[\s\S]*\}/, '').trim();
  }
  return { calls, rest };
}

/** Removes <think>…</think> blocks some reasoning models put in the content. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function firstLines(s: string, lines: number, width = 160): string {
  return s
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, lines)
    .map((l) => truncate(l, width))
    .join('\n');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.replace(/^https?:\/\/www\./, 'https://').replace(/^http:\/\//, 'https://');
  } catch {
    return url;
  }
}
