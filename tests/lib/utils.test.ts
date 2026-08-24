import { describe, it, expect } from 'vitest';
import { cn, compactNumber, timeAgo, formatDuration, clamp, shortenPath, pluralize } from '@/lib/utils';

describe('utils', () => {
  it('merges conflicting tailwind classes, last one wins', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-sm', false && 'hidden', 'font-bold')).toBe('text-sm font-bold');
  });

  it('formats compact numbers', () => {
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(1500)).toBe('1.5k');
    expect(compactNumber(1_200_000)).toBe('1.2M');
  });

  it('formats relative time', () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 30_000))).toBe('just now');
    expect(timeAgo(new Date(now - 3 * 60 * 60 * 1000))).toBe('3h ago');
    expect(timeAgo(null)).toBe('never');
  });

  it('formats durations', () => {
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(4_500)).toBe('4.5s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('clamps values into range', () => {
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(42, 0, 100)).toBe(42);
  });

  it('shortens long paths from the left', () => {
    const long = 'src/services/payments/internal/handlers/charge-customer.ts';
    const short = shortenPath(long, 30);
    expect(short.length).toBeLessThanOrEqual(30);
    expect(short).toContain('charge-customer.ts');
    expect(shortenPath('src/a.ts', 30)).toBe('src/a.ts');
  });

  it('pluralises correctly', () => {
    expect(pluralize(1, 'finding')).toBe('1 finding');
    expect(pluralize(3, 'finding')).toBe('3 findings');
    expect(pluralize(0, 'finding')).toBe('0 findings');
  });
});
