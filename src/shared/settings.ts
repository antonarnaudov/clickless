import type { ProviderConfig, Settings } from './types';

export const APP_NAME = 'Clickless';
export const APP_SCHEME = 'clickless';
export const DEFAULT_CONTROL_PORT = 7734;

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'google',
  askBackend: 'brave',
  askReadPages: 5,
  providers: [],
  agentProviderId: null,
  askProviderId: null,
  control: { enabled: true, port: DEFAULT_CONTROL_PORT, cdpPort: null },
  agent: { maxSteps: 40, showCursor: true, cursorMs: 220, dialogs: 'accept' },
  tabs: { archiveAfterHours: 12, sleepAfterMinutes: 30 },
  searchSuggestions: true,
  backup: { target: null, schedule: 'daily', keep: 10, lastAt: null, lastWhere: null, lastError: null },
  appearance: { theme: 'system', compactUrl: false },
};

export const SEARCH_ENGINES: Record<Exclude<Settings['searchEngine'], 'custom'>, { label: string; url: string }> = {
  google: { label: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { label: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  kagi: { label: 'Kagi', url: 'https://kagi.com/search?q=%s' },
};

export interface ProviderPreset extends Omit<ProviderConfig, 'id' | 'hasKey'> {
  /** Preset key, stable. */
  preset: string;
  needsKey: boolean;
  /** Where to get a key / install. */
  help: string;
}

/** Presets the settings UI offers. Model names are editable; "List models" fetches the real list. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    preset: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic',
    model: 'claude-opus-5-5',
    effort: 'medium',
    vision: true,
    needsKey: true,
    help: 'API key from console.anthropic.com',
  },
  {
    preset: 'claude-code',
    kind: 'claude-code',
    label: 'Claude Code',
    model: 'default',
    vision: true,
    needsKey: false,
    help: 'Uses your local `claude` CLI and its login (subscription or API key). No key needed here.',
  },
  {
    preset: 'openai',
    kind: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-5.1',
    vision: true,
    needsKey: true,
    help: 'API key from platform.openai.com',
  },
  {
    preset: 'openrouter',
    kind: 'openai',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-opus-5-5',
    vision: true,
    needsKey: true,
    help: 'One key for hundreds of models: openrouter.ai/keys',
  },
  {
    preset: 'gemini',
    kind: 'openai',
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    vision: true,
    needsKey: true,
    help: 'API key from aistudio.google.com',
  },
  {
    preset: 'ollama',
    kind: 'openai',
    label: 'Ollama',
    baseURL: 'http://localhost:11434/v1',
    model: 'qwen3:14b',
    vision: false,
    needsKey: false,
    help: 'Local models. Install from ollama.com, then `ollama pull qwen3:14b` (any tool-calling model works).',
  },
  {
    preset: 'lmstudio',
    kind: 'openai',
    label: 'LM Studio',
    baseURL: 'http://localhost:1234/v1',
    model: 'local-model',
    vision: false,
    needsKey: false,
    help: 'Start the local server in LM Studio (Developer tab).',
  },
  {
    preset: 'groq',
    kind: 'openai',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    vision: false,
    needsKey: true,
    help: 'API key from console.groq.com',
  },
  {
    preset: 'custom',
    kind: 'openai',
    label: 'Custom (OpenAI-compatible)',
    baseURL: 'http://localhost:8000/v1',
    model: 'model-name',
    vision: false,
    needsKey: false,
    help: 'Any server with /chat/completions and tool calling: vLLM, llama.cpp, LiteLLM, Together, DeepSeek…',
  },
];

// Sage is the default space: it tints the chrome softly. Spaces never colour buttons (docs/BRAND.md).
export const SPACE_COLORS = ['#5f7f75', '#10a592', '#7c5cff', '#3b82f6', '#ec4899', '#f59e0b', '#ef4444', '#64748b'];
