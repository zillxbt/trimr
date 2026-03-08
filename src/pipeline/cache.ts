import { createHash } from 'crypto';
import type { Session } from '../session.js';

// ── Anthropic API type stubs ──────────────────────────────────────────────────

export interface CacheControl {
  type: 'ephemeral';
  ttl?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  cache_control?: CacheControl;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | ContentBlock[];
  messages: AnthropicMessage[];
  stream?: boolean;
  temperature?: number;
  [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function extractSystemText(system: string | ContentBlock[]): string {
  if (typeof system === 'string') return system;
  return system
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text as string)
    .join('');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Normalises the system prompt into the block format and attaches
 * Anthropic's native cache_control breakpoint so the prompt is cached
 * server-side after the first call (subsequent calls cost ~10%).
 *
 * Preserves existing cache_control blocks from the incoming request.
 * Only adds a bare `{type: 'ephemeral'}` (no explicit TTL) to avoid
 * violating Anthropic's non-increasing TTL ordering constraint
 * (tools → system → messages).
 */
export function applySystemPromptCache(
  request: AnthropicRequest,
  session: Session,
): { request: AnthropicRequest; wasCacheHit: boolean } {
  if (!request.system) return { request, wasCacheHit: false };

  const systemText = extractSystemText(request.system);
  const hash = hashText(systemText);
  const wasCacheHit = session.systemPromptHashes.has(hash);

  session.systemPromptHashes.add(hash);

  // If the system prompt is already in block format, preserve existing
  // cache_control entries (and their TTLs) to avoid breaking ordering.
  if (Array.isArray(request.system)) {
    const blocks = request.system as ContentBlock[];
    const hasCache = blocks.some((b) => b.cache_control);
    if (hasCache) {
      // Already has cache_control — pass through unchanged.
      return { request, wasCacheHit };
    }
    // No cache_control yet — add bare ephemeral to the last text block.
    const safeTtl = pickSafeSystemTtl(request);
    const lastTextIdx = findLastIndex(blocks, (b) => b.type === 'text');
    if (lastTextIdx >= 0) {
      const patched = blocks.map((b, i) =>
        i === lastTextIdx
          ? { ...b, cache_control: safeTtl }
          : b,
      );
      return { request: { ...request, system: patched }, wasCacheHit };
    }
  }

  // String system prompt — convert to block format.
  const systemBlock: ContentBlock = {
    type: 'text',
    text: systemText,
    cache_control: pickSafeSystemTtl(request),
  };

  return {
    request: { ...request, system: [systemBlock] },
    wasCacheHit,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Determine a safe cache_control value for the system prompt.
 *
 * Anthropic requires cache_control TTLs in non-increasing order across
 * tools → system → messages.  Because the proxy only controls the
 * system block and can't modify message blocks that Claude Code already
 * set, we must never add an explicit TTL that could conflict with
 * message TTLs.  A bare `{type: 'ephemeral'}` (no `ttl` field) is
 * always safe — it doesn't participate in the TTL ordering check.
 */
function pickSafeSystemTtl(_request: AnthropicRequest): CacheControl {
  return { type: 'ephemeral' };
}

function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}
