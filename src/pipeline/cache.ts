import { createHash } from 'crypto';
import type { Session } from '../session.js';

// ── Anthropic API type stubs ──────────────────────────────────────────────────

export interface CacheControl {
  type: 'ephemeral';
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
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
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

  const systemBlock: ContentBlock = {
    type: 'text',
    text: systemText,
    cache_control: { type: 'ephemeral' },
  };

  return {
    request: { ...request, system: [systemBlock] },
    wasCacheHit,
  };
}
