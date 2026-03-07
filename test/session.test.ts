import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getOrCreateSession, getAllSessions, hashApiKey } from '../src/session.js';

test('creates a new session with correct defaults', () => {
  const s = getOrCreateSession('sess-defaults');
  assert.equal(s.id, 'sess-defaults');
  assert.ok(s.createdAt <= Date.now());
  assert.ok(s.lastActivity <= Date.now());
  assert.ok(s.systemPromptHashes instanceof Set);
  assert.ok(s.fileSnapshots instanceof Map);
});

test('all stats fields initialise to zero', () => {
  const { stats } = getOrCreateSession('sess-zero');
  assert.equal(stats.requestCount, 0);
  assert.equal(stats.tokensOriginal, 0);
  assert.equal(stats.tokensSaved, 0);
  assert.equal(stats.cacheHits, 0);
  assert.equal(stats.diffsSent, 0);
  assert.equal(stats.summariesDone, 0);
  assert.equal(stats.dedupHits, 0);
  assert.equal(stats.realInputTokens, 0);
  assert.equal(stats.outputTokens, 0);
  assert.equal(stats.cacheReadTokens, 0);
});

test('same session ID returns the same object', () => {
  const s1 = getOrCreateSession('sess-same-id');
  const s2 = getOrCreateSession('sess-same-id');
  assert.equal(s1, s2);
});

test('lastActivity is updated on each access', async () => {
  const s = getOrCreateSession('sess-activity');
  const t1 = s.lastActivity;
  await new Promise((r) => setTimeout(r, 5));
  getOrCreateSession('sess-activity');
  assert.ok(s.lastActivity >= t1);
});

test('getAllSessions includes all created sessions', () => {
  getOrCreateSession('sess-all-a');
  getOrCreateSession('sess-all-b');
  const ids = getAllSessions().map((s) => s.id);
  assert.ok(ids.includes('sess-all-a'));
  assert.ok(ids.includes('sess-all-b'));
});

test('mutating stats on one session does not affect another', () => {
  const s1 = getOrCreateSession('sess-mut-a');
  const s2 = getOrCreateSession('sess-mut-b');
  s1.stats.requestCount = 42;
  assert.equal(s2.stats.requestCount, 0);
});

test('hashApiKey produces consistent hashes', () => {
  const h1 = hashApiKey('sk-ant-test-key-123');
  const h2 = hashApiKey('sk-ant-test-key-123');
  assert.equal(h1, h2);
  assert.equal(h1.length, 16);
});

test('hashApiKey produces different hashes for different keys', () => {
  const h1 = hashApiKey('sk-ant-key-aaa');
  const h2 = hashApiKey('sk-ant-key-bbb');
  assert.notEqual(h1, h2);
});
