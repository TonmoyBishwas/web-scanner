import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { complete } from './llm-client';

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: ' {"a":1} ' } }] }), { status: 200 });
const bad = () => new Response(JSON.stringify({ error: { message: 'invalid argument' } }), { status: 400 });

describe('complete() json mode', () => {
  const saved = { ...process.env };
  let bodies: Record<string, unknown>[];
  beforeEach(() => {
    bodies = [];
    process.env.GEMINI_API_KEY = 'g';
    process.env.OPENROUTER_API_KEY = 'o';
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_THINKING;
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });
  const stub = (...answers: Array<() => Response>) =>
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return (answers.shift() ?? ok)();
    }));

  it('asks Gemini direct for a JSON object', async () => {
    stub(ok);
    expect(await complete('google/gemini-3.1-flash-lite', [{ role: 'user', content: 'x' }], { json: true })).toBe('{"a":1}');
    expect(bodies[0].response_format).toEqual({ type: 'json_object' });
    expect(bodies[0].reasoning_effort).toBe('none');
  });

  it('resends the plain request when Gemini refuses the extras', async () => {
    stub(bad, ok);
    await complete('google/gemini-3.1-flash-lite', [{ role: 'user', content: 'x' }], { json: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].response_format).toBeUndefined();
  });

  it('never sends JSON mode to OpenRouter or without the option', async () => {
    stub(ok, ok);
    await complete('anthropic/claude-haiku-4.5', [{ role: 'user', content: 'x' }], { json: true });
    await complete('google/gemini-3.1-flash-lite', [{ role: 'user', content: 'x' }]);
    expect(bodies[0].response_format).toBeUndefined();
    expect(bodies[1].response_format).toBeUndefined();
  });
});
