/**
 * Shared primitives: deterministic randomness, hashing, ids, text-safe helpers.
 * Everything here is dependency-free and deterministic so the whole pipeline is testable offline.
 */
import { createHash, randomUUID } from 'node:crypto';

/** FNV-1a 32-bit hash. Stable across runs and platforms (unlike Math.random or object ordering). */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG — small, fast, deterministic. Used to make sampling reproducible per seed. */
export function seededRandom(seed: string | number): () => number {
  let state = (typeof seed === 'number' ? seed : fnv1a(seed)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(items: readonly T[], rand: () => number): T {
  if (items.length === 0) throw new Error('pick() called with empty array');
  const idx = Math.floor(rand() * items.length);
  // Length is > 0 so index is always in range.
  return items[Math.min(idx, items.length - 1)] as T;
}

export function sample<T>(items: readonly T[], count: number, rand: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rand() * pool.length);
    const item = pool.splice(idx, 1)[0];
    if (item !== undefined) out.push(item);
  }
  return out;
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Cosine similarity of two equal-length numeric vectors. Returns 0 for empty input. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Normalize to unit length in place-safe fashion. */
export function normalizeVector(vec: readonly number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec.map(() => 0);
  return vec.map((v) => v / norm);
}

/** Deterministic hashed embedding (hashing trick) over word + character 3-grams. */
export function hashedEmbedding(text: string, dims = 192): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = tokenize(text).filter((t) => !STOP_WORDS.has(t));
  const add = (feature: string, weight: number) => {
    const idx = fnv1a(feature) % dims;
    // A second, independent hash decides the sign to keep collisions unbiased.
    const sign = (fnv1a(`s:${feature}`) & 1) === 0 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign * weight;
  };
  for (const token of tokens) {
    add(`w:${token}`, 1);
    for (let i = 0; i + 3 <= token.length; i++) add(`g:${token.slice(i, i + 3)}`, 0.35);
  }
  return normalizeVector(vec);
}

export function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function contentId(prefix: string): string {
  return `${prefix}_${createHash('sha256').update(String(prefix)).digest('hex').slice(0, 16)}`;
}

export function slugify(input: string, maxLen = 60): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

export function titleCase(input: string): string {
  return input.replace(/\b([a-z])(\w*)/g, (_, head: string, tail: string) => head.toUpperCase() + tail);
}

export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

export function groupBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

export function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/** Word tokenizer: keeps contractions, intra-word apostrophes and hyphens intact. */
export function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Strip URLs but keep a placeholder so link habits remain measurable.
      .replace(/https?:\/\/\S+/g, ' __url__ ')
      .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []
  );
}

/** Split into sentences without a dependency; handles abbreviations and code blocks conservatively. */
export function splitSentences(text: string): string[] {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[.!?]+/g, ''))
    .replace(/\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|approx)\./gi, (m) => m.replace('.', ''));
  const parts = cleaned
    .split(/(?<=[.!?])\s+|\n{2,}/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts;
}

export function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/** Characters per 1000, a normalizable rate metric. */
export function rate(count: number, chars: number): number {
  return chars === 0 ? 0 : (count / chars) * 1000;
}

export function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ');
}

export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'of', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this',
  'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'them', 'my', 'your', 'our', 'their',
  'me', 'us', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
  'not', 'no', 'yes', 'up', 'out', 'about', 'into', 'over', 'after', 'before', 'just', 'now', 'only',
  'also', 'more', 'most', 'some', 'such', 'there', 'here', 'when', 'where', 'why', 'how', 'all', 'any',
  'each', 'few', 'other', 'own', 'same', 'very', 'am', 'get', 'got', 'like', 'make', 'made',
]);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}