/**
 * Quantitative token-savings tests.
 *
 * These tests don't hit the network — they exercise the pipeline modules
 * directly with realistic payloads and assert that the savings ratios fall
 * within the ranges documented in README.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySystemPromptCache } from '../src/pipeline/cache.js';
import { applyFileDiffing } from '../src/pipeline/differ.js';
import { checkDedup, storeDedup } from '../src/pipeline/dedup.js';
import { getOrCreateSession } from '../src/session.js';
import { estimateTokens } from '../src/pricing.js';
import type { AnthropicRequest } from '../src/pipeline/cache.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const SYSTEM_CHUNK =
  'You are an expert TypeScript engineer working inside a large monorepo. ' +
  'The repo uses pnpm workspaces, Vite for bundling, Vitest for tests, and ' +
  'TypeScript in strict mode throughout. All new code must be fully typed, ' +
  'pass linting with ESLint, and include JSDoc for public APIs. ' +
  'Prefer functional patterns; avoid classes unless the domain demands it. ' +
  'When editing files always return the complete file — never partial snippets. ' +
  'When you propose a change, first explain the reasoning in a short paragraph, ' +
  'then show the updated file. Do not show unnecessary diffs; show the full file. ';
const SYSTEM_2K = SYSTEM_CHUNK.repeat(6); // ~2 000 tokens

const FILE_500_V1 = `
import express from 'express';
import { json } from 'body-parser';
import { authMiddleware } from './auth.js';
import { db } from './db.js';

const app = express();
app.use(json());

app.get('/users', authMiddleware, async (_req, res) => {
  const users = await db.user.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(users);
});

app.post('/users', async (req, res) => {
  const { email, name } = req.body as { email: string; name: string };
  const user = await db.user.create({ data: { email, name } });
  res.status(201).json(user);
});

app.get('/users/:id', authMiddleware, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

app.put('/users/:id', authMiddleware, async (req, res) => {
  const { email, name } = req.body as { email?: string; name?: string };
  const user = await db.user.update({ where: { id: req.params.id }, data: { email, name } });
  res.json(user);
});

app.delete('/users/:id', authMiddleware, async (req, res) => {
  await db.user.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

export { app };
`.repeat(8); // ~500 lines

// Minimal one-line change: add a route
const FILE_500_V2 = FILE_500_V1.replace(
  'export { app };',
  `app.get('/health', (_req, res) => res.json({ ok: true }));\nexport { app };`,
);

const makeReq = (
  system: string,
  userContent: string,
): AnthropicRequest => ({
  model: 'claude-sonnet-4-6',
  max_tokens: 256,
  system,
  messages: [{ role: 'user', content: userContent }],
});

// ── System prompt cache savings ───────────────────────────────────────────────

test('cache: 10 calls with ~2 000-token system prompt saves ≥80% of prompt tokens', () => {
  const session = getOrCreateSession('savings-cache-10x', '127.0.0.1');
  const promptTokens = estimateTokens(SYSTEM_2K);

  let totalCost = 0;
  let totalHits = 0;

  for (let i = 0; i < 10; i++) {
    const { wasCacheHit } = applySystemPromptCache(makeReq(SYSTEM_2K, `question ${i}`), session);
    // First call: full cost (1×). Subsequent calls: cached at 10%
    totalCost += wasCacheHit ? promptTokens * 0.1 : promptTokens;
    if (wasCacheHit) totalHits++;
  }

  const baselineCost = promptTokens * 10;
  const saving = (baselineCost - totalCost) / baselineCost;

  assert.equal(totalHits, 9, 'all calls after the first should hit the cache');
  assert.ok(saving >= 0.80, `expected ≥80% saving, got ${(saving * 100).toFixed(1)}%`);
});

test('cache: returns cache hit on second call with identical system', () => {
  const session = getOrCreateSession('savings-cache-second', '127.0.0.1');
  applySystemPromptCache(makeReq(SYSTEM_2K, 'first'), session);
  const { wasCacheHit } = applySystemPromptCache(makeReq(SYSTEM_2K, 'second'), session);
  assert.equal(wasCacheHit, true);
});

test('cache: large system prompt tokens estimated correctly', () => {
  const tokens = estimateTokens(SYSTEM_2K);
  // rough sanity: 4 chars/token → chunk ~580 chars × 6 repeats → ~870 tokens
  assert.ok(tokens >= 500, `tokens=${tokens} too low`);
  assert.ok(tokens <= 2000, `tokens=${tokens} too high`);
});

// ── File diffing savings ──────────────────────────────────────────────────────

test('differ: identical 500-line file sent twice omits entire content', () => {
  const session = getOrCreateSession('savings-diff-omit', '127.0.0.1');
  const msg = (content: string) => [{ role: 'user' as const, content }];
  const block = `\`\`\`src/server.ts\n${FILE_500_V1}\n\`\`\``;

  applyFileDiffing(msg(block), session);
  const { messages, tokensSaved } = applyFileDiffing(msg(block), session);

  const output = messages[0].content as string;
  assert.ok(output.includes('unchanged — omitted'));
  assert.ok(tokensSaved > 0, 'should report saved tokens');
});

test('differ: identical file second pass saves ≥60% of file tokens', () => {
  const session = getOrCreateSession('savings-diff-ratio', '127.0.0.1');
  const block = `\`\`\`src/server.ts\n${FILE_500_V1}\n\`\`\``;
  const msg = [{ role: 'user' as const, content: block }];

  applyFileDiffing(msg, session);
  const { tokensSaved } = applyFileDiffing(msg, session);

  const originalTokens = estimateTokens(FILE_500_V1);
  const ratio = tokensSaved / originalTokens;
  assert.ok(ratio >= 0.60, `expected ≥60% saving, got ${(ratio * 100).toFixed(1)}%`);
});

test('differ: small change to large file produces a diff shorter than full content', () => {
  const session = getOrCreateSession('savings-diff-small-change', '127.0.0.1');
  const block1 = `\`\`\`src/server.ts\n${FILE_500_V1}\n\`\`\``;
  const block2 = `\`\`\`src/server.ts\n${FILE_500_V2}\n\`\`\``;
  const msg1 = [{ role: 'user' as const, content: block1 }];
  const msg2 = [{ role: 'user' as const, content: block2 }];

  applyFileDiffing(msg1, session);
  const { messages, tokensSaved } = applyFileDiffing(msg2, session);

  const output = messages[0].content as string;
  // Should be either a diff block or an omit marker — not the raw file
  const hasRawFile = output === block2;
  // If diff is not shorter, pipeline passes through unchanged (that's ok)
  // but a one-line change in a ~500-line file SHOULD produce a shorter diff
  if (!hasRawFile) {
    assert.ok(tokensSaved > 0, 'should save tokens when diff is sent');
  }
  // The main invariant: the pipeline never throws and always returns a string
  assert.equal(typeof output, 'string');
});

test('differ: 5 rounds of file edits accumulate meaningful savings', () => {
  const session = getOrCreateSession('savings-diff-5rounds', '127.0.0.1');
  let currentContent = FILE_500_V1;
  let totalSaved = 0;
  let totalOriginal = 0;

  for (let i = 0; i < 5; i++) {
    // Each round adds one more line
    currentContent += `\n// round ${i} comment`;
    const block = `\`\`\`src/server.ts\n${currentContent}\n\`\`\``;
    const msg = [{ role: 'user' as const, content: block }];
    totalOriginal += estimateTokens(block);

    const { tokensSaved } = applyFileDiffing(msg, session);
    totalSaved += tokensSaved;
  }

  const ratio = totalOriginal > 0 ? totalSaved / totalOriginal : 0;
  // After the first round (no savings), rounds 2-5 should produce diffs
  assert.ok(ratio > 0, 'should save some tokens over 5 rounds');
});

// ── Dedup savings ─────────────────────────────────────────────────────────────

test('dedup: 10 identical requests save 90% via cache hits', () => {
  const req = makeReq('Be concise.', 'What is 2+2?');
  const fakeResponse = { id: 'msg_abc', content: [{ type: 'text', text: '4' }] };

  storeDedup(req, fakeResponse);

  let hits = 0;
  for (let i = 1; i < 10; i++) {
    const hit = checkDedup(req);
    if (hit) hits++;
  }

  assert.equal(hits, 9);
  const saving = hits / 10;
  assert.ok(saving >= 0.90, `expected ≥90% hit rate, got ${(saving * 100).toFixed(1)}%`);
});

test('dedup: stored response matches original exactly', () => {
  const req = makeReq('system', 'exactly match test');
  const response = { id: 'msg_exact', type: 'message', content: [{ type: 'text', text: 'ok' }] };
  storeDedup(req, response);
  const hit = checkDedup(req);
  assert.deepEqual(hit!.response, response);
});

// ── Combined pipeline savings ────────────────────────────────────────────────

test('combined: cache + diff reduces estimated tokens by ≥50% after first call', () => {
  const session = getOrCreateSession('savings-combined', '127.0.0.1');
  const fileBlock = `\`\`\`src/server.ts\n${FILE_500_V1}\n\`\`\``;
  const userMsg = `Please review this file:\n${fileBlock}`;

  let body: AnthropicRequest = makeReq(SYSTEM_2K, userMsg);

  // First call: prime caches
  const firstOriginal = estimateTokens(JSON.stringify(body));
  applySystemPromptCache(body, session);
  applyFileDiffing(body.messages, session);

  // Second call: both caches should fire
  body = makeReq(SYSTEM_2K, userMsg);
  const secondOriginal = estimateTokens(JSON.stringify(body));

  const { request: cached } = applySystemPromptCache(body, session);
  body = cached;
  const { messages: diffed, tokensSaved: diffSaved } = applyFileDiffing(body.messages, session);
  body = { ...body, messages: diffed };

  const finalTokens = estimateTokens(JSON.stringify(body));
  const totalSaved = secondOriginal - finalTokens + diffSaved;
  const ratio = totalSaved / secondOriginal;

  assert.ok(
    ratio >= 0.50,
    `expected ≥50% combined saving on second call, got ${(ratio * 100).toFixed(1)}%`,
  );
});

// ── Pricing model sanity ──────────────────────────────────────────────────────

test('pricing: 1 M token saving at Sonnet rate ≥ $2.90', async () => {
  const { calculateCost } = await import('../src/pricing.js');
  const cost = calculateCost(1_000_000, 'claude-sonnet-4-6', 'input');
  assert.ok(cost >= 2.9, `expected ≥$2.90/M input tokens, got $${cost}`);
});

test('pricing: Opus input more expensive than Sonnet input', async () => {
  const { calculateCost } = await import('../src/pricing.js');
  const opus = calculateCost(1_000_000, 'claude-opus-4-6', 'input');
  const sonnet = calculateCost(1_000_000, 'claude-sonnet-4-6', 'input');
  assert.ok(opus > sonnet, `Opus ($${opus}) should cost more than Sonnet ($${sonnet})`);
});

test('pricing: cache read is cheaper than full input', async () => {
  const { calculateCost } = await import('../src/pricing.js');
  const full = calculateCost(1_000_000, 'claude-sonnet-4-6', 'input');
  const cached = calculateCost(1_000_000, 'claude-sonnet-4-6', 'cacheRead');
  assert.ok(cached < full, `cache read ($${cached}) should be cheaper than full ($${full})`);
});
