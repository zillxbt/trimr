import { createHash } from 'crypto';
import type { AnthropicRequest } from './cache.js';

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface JsonEntry {
  type: 'json';
  response: unknown;
  expiresAt: number;
}

interface StreamEntry {
  type: 'stream';
  bytes: Buffer;
  expiresAt: number;
}

type CacheEntry = JsonEntry | StreamEntry;

const cache = new Map<string, CacheEntry>();

export function hashRequest(req: AnthropicRequest): string {
  const payload = JSON.stringify({
    model: req.model,
    system: req.system,
    messages: req.messages,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function getEntry(req: AnthropicRequest): CacheEntry | null {
  const hash = hashRequest(req);
  const entry = cache.get(hash);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(hash);
    return null;
  }
  return entry;
}

export function checkDedup(req: AnthropicRequest): JsonEntry | null {
  const entry = getEntry(req);
  return entry?.type === 'json' ? entry : null;
}

export function checkStreamDedup(req: AnthropicRequest): StreamEntry | null {
  const entry = getEntry(req);
  return entry?.type === 'stream' ? entry : null;
}

export function storeDedup(req: AnthropicRequest, response: unknown): void {
  const hash = hashRequest(req);
  cache.set(hash, { type: 'json', response, expiresAt: Date.now() + DEDUP_TTL_MS });
}

export function storeStreamDedup(req: AnthropicRequest, bytes: Buffer): void {
  const hash = hashRequest(req);
  cache.set(hash, { type: 'stream', bytes, expiresAt: Date.now() + DEDUP_TTL_MS });
}

// Clean up expired entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [hash, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(hash);
  }
}, 60_000).unref();
