import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashRequest, checkDedup, storeDedup } from '../src/pipeline/dedup.js';
import type { AnthropicRequest } from '../src/pipeline/cache.js';

const req = (content: string): AnthropicRequest => ({
  model: 'claude-sonnet-4-6',
  max_tokens: 100,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content }],
});

test('hashRequest — same input produces same hash', () => {
  assert.equal(hashRequest(req('hello')), hashRequest(req('hello')));
});

test('hashRequest — different messages produce different hashes', () => {
  assert.notEqual(hashRequest(req('hello')), hashRequest(req('goodbye')));
});

test('hashRequest — different models produce different hashes', () => {
  const a = { ...req('hello'), model: 'claude-haiku-4-5-20251001' };
  const b = { ...req('hello'), model: 'claude-sonnet-4-6' };
  assert.notEqual(hashRequest(a), hashRequest(b));
});

test('hashRequest — different system prompts produce different hashes', () => {
  const a = { ...req('hello'), system: 'System A' };
  const b = { ...req('hello'), system: 'System B' };
  assert.notEqual(hashRequest(a), hashRequest(b));
});

test('hashRequest — output is 32 hex chars', () => {
  const hash = hashRequest(req('test'));
  assert.match(hash, /^[0-9a-f]{32}$/);
});

test('checkDedup — miss before storing', () => {
  assert.equal(checkDedup(req('never-stored-abc123')), null);
});

test('storeDedup + checkDedup — hit after storing', () => {
  const r = req('store-and-retrieve');
  const response = { id: 'msg_abc', content: [{ type: 'text', text: 'Hi' }] };
  storeDedup(r, response);
  const hit = checkDedup(r);
  assert.notEqual(hit, null);
  assert.deepEqual(hit!.response, response);
});

test('checkDedup — different request still misses after another is stored', () => {
  const stored = req('stored-request-xyz');
  storeDedup(stored, { id: 'msg_1' });
  assert.equal(checkDedup(req('different-request-xyz')), null);
});

test('storeDedup — overwriting same key updates response', () => {
  const r = req('overwrite-test');
  storeDedup(r, { id: 'msg_old' });
  storeDedup(r, { id: 'msg_new' });
  const hit = checkDedup(r);
  assert.notEqual(hit, null);
  assert.deepEqual(hit!.response, { id: 'msg_new' });
});

test('checkDedup — hit has future expiresAt', () => {
  const r = req('ttl-check-test');
  storeDedup(r, { id: 'msg_ttl' });
  const hit = checkDedup(r);
  assert.notEqual(hit, null);
  assert.ok(hit!.expiresAt > Date.now());
});
