import { createHash, randomUUID } from 'node:crypto';

export function uuid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** `Sarah O'Brien` -> `sarah_o_brien`; used as the stable character key. */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    // strip combining diacritics so "Renée" and "Renee" collapse together
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Humanise a slug back for display: `sarah_o_brien` -> `Sarah O Brien`. */
export function titleCase(slug: string): string {
  return slug
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function pad(value: number, width: number): string {
  return String(Math.floor(value)).padStart(width, '0');
}

/** Stable stringify so payload hashes do not depend on key insertion order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

/** Split an array into fixed-size groups (used by merge batching, not chunking). */
export function groupBy<T, K extends string | number>(items: T[], keyFn: (item: T) => K) {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = out.get(key);
    if (bucket) bucket.push(item);
    else out.set(key, [item]);
  }
  return out;
}
