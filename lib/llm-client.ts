/**
 * One chat-completion call for the scanner's two server-side model uses
 * (`/api/consolidate-items`, `lib/llm-matcher.ts`), with the same provider
 * toggle the bot has:
 *
 *   LLM_PROVIDER=gemini      → Gemini API direct through its OpenAI-compatible
 *                              endpoint (default when GEMINI_API_KEY is set).
 *                              Thinking is OFF unless LLM_THINKING=on.
 *                              Non-Google models in a chain still go to
 *                              OpenRouter when OPENROUTER_API_KEY is present.
 *   LLM_PROVIDER=openrouter  → everything through OpenRouter, as before.
 *
 * Model ids stay in OpenRouter's `vendor/model` form; the vendor prefix is
 * stripped for Gemini and ids Gemini no longer serves are mapped forward.
 * Server-only: never import from a client component.
 */

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const GEMINI_ALIASES: Record<string, string> = {
  'gemini-2.5-flash-lite': 'gemini-3.1-flash-lite',
  'gemini-2.5-flash': 'gemini-3.5-flash-lite',
  'gemini-2.5-pro': 'gemini-3.1-pro-preview',
};

export type Provider = 'gemini' | 'openrouter';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

export interface CompleteOptions {
  timeoutMs?: number;
  temperature?: number;
  /** Extra request headers (OpenRouter attribution only). */
  referer?: string;
  title?: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function activeProvider(): Provider {
  const raw = (env('LLM_PROVIDER') || '').toLowerCase();
  if (raw === 'gemini' || raw === 'openrouter') return raw;
  return env('GEMINI_API_KEY') ? 'gemini' : 'openrouter';
}

function thinkingOn(): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env('LLM_THINKING') || '').toLowerCase());
}

function isGoogle(model: string): boolean {
  return model.startsWith('google/') || !model.includes('/');
}

/** Where one chain entry runs, or null when it has no route. */
export function route(model: string): { provider: Provider; model: string; key: string } | null {
  const gemini = env('GEMINI_API_KEY');
  const openrouter = env('OPENROUTER_API_KEY');
  if (activeProvider() === 'gemini' && isGoogle(model) && gemini) {
    const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
    return { provider: 'gemini', model: GEMINI_ALIASES[bare] ?? bare, key: gemini };
  }
  if (openrouter) return { provider: 'openrouter', model, key: openrouter };
  return null;
}

/** The chain entries that can actually be called right now. */
export function usableModels(models: string[]): string[] {
  return models.filter((m) => route(m) !== null);
}

export class LLMHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** One completion; resolves to the assistant text (trimmed). Throws on any failure. */
export async function complete(
  model: string,
  messages: ChatMessage[],
  opts: CompleteOptions = {},
): Promise<string> {
  const r = route(model);
  if (!r) throw new Error(`${model}: no provider route (${activeProvider()})`);

  const url = r.provider === 'gemini' ? GEMINI_URL : OPENROUTER_URL;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${r.key}`,
  };
  if (r.provider === 'openrouter') {
    headers['HTTP-Referer'] = opts.referer || 'https://web-scanner.warehouse.local';
    headers['X-Title'] = opts.title || 'Hebrew Warehouse Scanner';
  }
  const base: Record<string, unknown> = { model: r.model, messages };
  if (opts.temperature !== undefined) base.temperature = opts.temperature;
  const noThink: Record<string, unknown> = thinkingOn()
    ? {}
    : r.provider === 'gemini'
      ? { reasoning_effort: 'none' }
      : { reasoning: { enabled: false } };

  const send = (body: Record<string, unknown>) =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    });

  let resp = await send({ ...base, ...noThink });
  if (resp.status === 400 && Object.keys(noThink).length) {
    // Some models make reasoning mandatory: retry once without the flag.
    resp = await send(base);
  }
  if (!resp.ok) throw new LLMHttpError(resp.status, `${r.provider}:${r.model} HTTP ${resp.status}`);

  let data = await resp.json();
  if (Array.isArray(data)) data = data[0] ?? {}; // Gemini wraps errors in a list
  if (data?.error && !data?.choices) {
    throw new Error(`${r.provider}:${r.model} error: ${JSON.stringify(data.error)}`);
  }
  let content = data?.choices?.[0]?.message?.content ?? '';
  if (Array.isArray(content)) {
    content = content.map((p: { text?: string }) => p?.text ?? '').join('');
  }
  return String(content).trim();
}
