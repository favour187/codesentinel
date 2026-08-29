import { describe, expect, it } from 'vitest';
import { isAIConfigured, parseJsonLoosely, truncate } from '@/ai/router';
import type { AICompletion, AICompletionRequest, AIProvider } from '@/ai/provider';







class Stub implements AIProvider {
  constructor(
    readonly id: string,
    readonly model: string,
    private readonly available: boolean,
  ) {}

  isAvailable(): boolean {
    return this.available;
  }

  async complete(_request: AICompletionRequest): Promise<AICompletion> {
    throw new Error('not used');
  }
}

describe('isAIConfigured', () => {
  it('is false when no provider has a key', () => {
    expect(isAIConfigured([new Stub('featherless', 'm', false)])).toBe(false);
  });

  it('is true when at least one provider is available', () => {
    expect(
      isAIConfigured([new Stub('featherless', 'm', false), new Stub('groq', 'm', true)]),
    ).toBe(true);
  });
});

describe('parseJsonLoosely', () => {
  it('parses a clean JSON object', () => {
    expect(parseJsonLoosely('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in a markdown fence', () => {
    expect(parseJsonLoosely('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in an unlabelled fence', () => {
    expect(parseJsonLoosely('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts JSON surrounded by prose', () => {
    expect(parseJsonLoosely('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('returns undefined for text with no JSON at all', () => {
    expect(parseJsonLoosely('I cannot help with that.')).toBeUndefined();
  });
});

describe('truncate', () => {
  it('leaves text within the limit untouched', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('cuts at a line boundary and marks the truncation', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const result = truncate(text, 200);

    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('truncated');

    const body = result.split('\n\n[')[0] ?? '';
    expect(body.endsWith('\n')).toBe(false);
  });
});
