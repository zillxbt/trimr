import { createHash } from 'crypto';

export interface FileSnapshot {
  content: string;
  timestamp: number;
}

export interface SessionStats {
  tokensOriginal: number;
  tokensSaved: number;
  cacheHits: number;
  diffsSent: number;
  summariesDone: number;
  requestCount: number;
  dedupHits: number;
  realInputTokens: number;   // from Anthropic usage (non-streaming only)
  outputTokens: number;      // from Anthropic usage
  cacheReadTokens: number;   // cache_read_input_tokens from usage
}

export interface Session {
  id: string;
  createdAt: number;
  lastActivity: number;
  /** SHA-256 hashes of system prompts seen in this session */
  systemPromptHashes: Set<string>;
  /** filename -> last-seen content, used to build diffs */
  fileSnapshots: Map<string, FileSnapshot>;
  stats: SessionStats;
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Hash an API key to use as session identifier */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

export function getOrCreateSession(sessionId: string): Session {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing;
  }

  const session: Session = {
    id: sessionId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    systemPromptHashes: new Set(),
    fileSnapshots: new Map(),
    stats: {
      tokensOriginal: 0,
      tokensSaved: 0,
      cacheHits: 0,
      diffsSent: 0,
      summariesDone: 0,
      requestCount: 0,
      dedupHits: 0,
      realInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    },
  };

  sessions.set(sessionId, session);
  return session;
}

export function getAllSessions(): Session[] {
  return Array.from(sessions.values());
}

export function getTotalTokensSaved(): number {
  let total = 0;
  for (const s of sessions.values()) {
    total += s.stats.tokensSaved;
  }
  return total;
}

export function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupExpiredSessions, 60_000).unref();
