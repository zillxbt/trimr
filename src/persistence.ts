import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Session } from './session.js';

const DATA_DIR  = join(homedir(), '.tokendiff');
const DATA_FILE = join(DATA_DIR, 'history.json');

// ── Types ─────────────────────────────────────────────────────────────────────

interface DayRecord {
  date: string;
  tokensOriginal: number;
  tokensSaved: number;
  requestCount: number;
  dedupHits: number;
  diffsSent: number;
}

interface HistoryFile {
  lifetime: {
    tokensOriginal: number;
    tokensSaved: number;
    realInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    requestCount: number;
    cacheHits: number;
    diffsSent: number;
    dedupHits: number;
    summariesDone: number;
  };
  days: DayRecord[];  // last 90 days, newest first
}

// ── In-memory state ───────────────────────────────────────────────────────────

let history: HistoryFile = {
  lifetime: {
    tokensOriginal: 0, tokensSaved: 0, realInputTokens: 0,
    outputTokens: 0, cacheReadTokens: 0, requestCount: 0,
    cacheHits: 0, diffsSent: 0, dedupHits: 0, summariesDone: 0,
  },
  days: [],
};

// Baseline snapshot from disk — used to avoid double-counting live sessions
let baselineReqCount = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function aggregate(sessions: Session[]) {
  const agg = {
    tokensOriginal: 0, tokensSaved: 0, realInputTokens: 0,
    outputTokens: 0, cacheReadTokens: 0, requestCount: 0,
    cacheHits: 0, diffsSent: 0, dedupHits: 0, summariesDone: 0,
  };
  for (const s of sessions) {
    agg.tokensOriginal  += s.stats.tokensOriginal;
    agg.tokensSaved     += s.stats.tokensSaved;
    agg.realInputTokens += s.stats.realInputTokens;
    agg.outputTokens    += s.stats.outputTokens;
    agg.cacheReadTokens += s.stats.cacheReadTokens;
    agg.requestCount    += s.stats.requestCount;
    agg.cacheHits       += s.stats.cacheHits;
    agg.diffsSent       += s.stats.diffsSent;
    agg.dedupHits       += s.stats.dedupHits;
    agg.summariesDone   += s.stats.summariesDone;
  }
  return agg;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function loadHistory(): HistoryFile {
  try {
    const raw = readFileSync(DATA_FILE, 'utf8');
    history = JSON.parse(raw) as HistoryFile;
    baselineReqCount = history.lifetime.requestCount;
  } catch {
    // First run or corrupt file — start fresh
  }
  return history;
}

export function getHistory(): HistoryFile {
  return history;
}

export function flushHistory(sessions: Session[]): void {
  try {
    ensureDir();
    const live = aggregate(sessions);
    const today = todayStr();

    // Merge lifetime: baseline + current live sessions
    const merged = { ...history.lifetime };
    for (const key of Object.keys(live) as Array<keyof typeof live>) {
      merged[key] = (history.lifetime[key] ?? 0) + live[key];
    }

    // Update today's day record
    const existing = history.days.find(d => d.date === today);
    const todayRecord: DayRecord = {
      date: today,
      tokensOriginal: (existing?.tokensOriginal ?? 0) + live.tokensOriginal,
      tokensSaved:    (existing?.tokensSaved    ?? 0) + live.tokensSaved,
      requestCount:   (existing?.requestCount   ?? 0) + live.requestCount,
      dedupHits:      (existing?.dedupHits      ?? 0) + live.dedupHits,
      diffsSent:      (existing?.diffsSent      ?? 0) + live.diffsSent,
    };

    const otherDays = history.days.filter(d => d.date !== today);
    const days = [todayRecord, ...otherDays].slice(0, 90); // keep 90 days

    const updated: HistoryFile = { lifetime: merged, days };
    writeFileSync(DATA_FILE, JSON.stringify(updated, null, 2));
    history = updated;
  } catch (e) {
    // Non-fatal — best-effort persistence
  }
}
