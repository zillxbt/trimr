import { createHash } from 'crypto';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AnthropicRequest } from './cache.js';

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Debug logging ────────────────────────────────────────────────────────────

const DEBUG_DIR = join(homedir(), '.trimr');
const DEBUG_LOG = join(DEBUG_DIR, 'debug-dedup.log');

function debugLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    appendFileSync(DEBUG_LOG, line);
  } catch { /* */ }
}

// ── Cache entries ────────────────────────────────────────────────────────────

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

// ── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Full-request hash: model + system + ALL messages.
 * Catches exact retries (identical request sent twice).
 */
export function hashRequest(req: AnthropicRequest): string {
  const payload = JSON.stringify({
    model: req.model,
    system: req.system,
    messages: req.messages,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * Last-turn hash: model + system + last user message only.
 * Catches cases where the conversation grew but the last user turn
 * is identical to a previous request's last turn (e.g. tool-use loops
 * where the model retries the same tool call and gets the same result).
 */
function hashLastTurn(req: AnthropicRequest): string {
  const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user');
  const payload = JSON.stringify({
    model: req.model,
    system: req.system,
    lastUser: lastUserMsg?.content ?? null,
    msgCount: req.messages.length,
  });
  return 'lt:' + createHash('sha256').update(payload).digest('hex').slice(0, 30);
}

// ── Cache lookup ─────────────────────────────────────────────────────────────

function getEntry(hash: string): CacheEntry | null {
  const entry = cache.get(hash);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(hash);
    return null;
  }
  return entry;
}

function tryGetEntry(req: AnthropicRequest): { entry: CacheEntry; hashUsed: string } | null {
  // Try full-request hash first (exact retry)
  const fullHash = hashRequest(req);
  const fullEntry = getEntry(fullHash);
  if (fullEntry) {
    debugLog(`[dedup] FULL HASH HIT: ${fullHash}`);
    return { entry: fullEntry, hashUsed: fullHash };
  }

  // Try last-turn hash (conversation-aware dedup)
  const ltHash = hashLastTurn(req);
  const ltEntry = getEntry(ltHash);
  if (ltEntry) {
    debugLog(`[dedup] LAST-TURN HASH HIT: ${ltHash}`);
    return { entry: ltEntry, hashUsed: ltHash };
  }

  debugLog(`[dedup] MISS — fullHash=${fullHash.slice(0, 12)} ltHash=${ltHash.slice(0, 15)} ` +
    `cacheSize=${cache.size} msgCount=${req.messages.length} model=${req.model} stream=${req.stream}`);
  return null;
}

export function checkDedup(req: AnthropicRequest): JsonEntry | null {
  const result = tryGetEntry(req);
  return result?.entry.type === 'json' ? result.entry : null;
}

export function checkStreamDedup(req: AnthropicRequest): StreamEntry | null {
  const result = tryGetEntry(req);
  return result?.entry.type === 'stream' ? result.entry : null;
}

// ── Cache storage ────────────────────────────────────────────────────────────

export function storeDedup(req: AnthropicRequest, response: unknown): void {
  const fullHash = hashRequest(req);
  const ltHash = hashLastTurn(req);
  const entry: JsonEntry = { type: 'json', response, expiresAt: Date.now() + DEDUP_TTL_MS };

  // Store under both hashes
  cache.set(fullHash, entry);
  cache.set(ltHash, entry);
  debugLog(`[dedup] STORED json under fullHash=${fullHash.slice(0, 12)} ltHash=${ltHash.slice(0, 15)}`);
}

export function storeStreamDedup(req: AnthropicRequest, bytes: Buffer): void {
  const fullHash = hashRequest(req);
  const ltHash = hashLastTurn(req);
  const entry: StreamEntry = { type: 'stream', bytes, expiresAt: Date.now() + DEDUP_TTL_MS };

  // Store under both hashes
  cache.set(fullHash, entry);
  cache.set(ltHash, entry);
  debugLog(`[dedup] STORED stream (${bytes.length} bytes) under fullHash=${fullHash.slice(0, 12)} ltHash=${ltHash.slice(0, 15)}`);
}

// Clean up expired entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [hash, entry] of cache) {
    if (now > entry.expiresAt) {
      cache.delete(hash);
      cleaned++;
    }
  }
  if (cleaned > 0) debugLog(`[dedup] cleanup: removed ${cleaned} expired entries`);
}, 60_000).unref();
