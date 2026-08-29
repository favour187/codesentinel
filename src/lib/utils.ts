import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}


export function compactNumber(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
    .format(n)
    .replace('K', 'k');
}


export function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return 'never';
  const d = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (Number.isNaN(seconds)) return 'unknown';
  if (seconds < 45) return 'just now';


  const units: Array<[suffix: string, seconds: number]> = [
    ['y', 31_536_000],
    ['mo', 2_592_000],
    ['w', 604_800],
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
    ['s', 1],
  ];
  for (const [suffix, secondsInUnit] of units) {
    if (Math.abs(seconds) >= secondsInUnit) {
      const value = Math.round(seconds / secondsInUnit);
      return seconds < 0 ? `in ${Math.abs(value)}${suffix}` : `${value}${suffix} ago`;
    }
  }
  return 'just now';
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}


export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}


export function shortenPath(path: string, maxLength = 40): string {
  if (path.length <= maxLength) return path;

  const parts = path.split('/');
  const fileName = parts[parts.length - 1] ?? path;


  if (fileName.length + 2 >= maxLength) return `…/${fileName}`;

  let result = fileName;
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = `${parts[i]}/${result}`;
    if (candidate.length + 2 > maxLength) return `…/${result}`;
    result = candidate;
  }
  return result;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  const word = count === 1 ? singular : (plural ?? `${singular}s`);
  return `${count} ${word}`;
}
