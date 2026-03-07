import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySystemPromptCache } from '../src/pipeline/cache.js';
import { getOrCreateSession } from '../src/session.js';
import type { AnthropicRequest } from '../src/pipeline/cache.js';

const makeReq = (system: string | undefined, suffix = ''): AnthropicRequest => ({
  model: 'claude-sonnet-4-6',
  max_tokens: 32,
  system,
  messages: [{ role: 'user', content: `Hello ${suffix}` }],
});

test('no system prompt — request returned unchanged', () => {
  const session = getOrCreateSession('cache-no-system', '127.0.0.1');
  const { request, wasCacheHit } = applySystemPromptCache(makeReq(undefined), session);
  assert.equal(wasCacheHit, false);
  assert.equal(request.system, undefined);
});

test('first call — not a cache hit', () => {
  const session = getOrCreateSession('cache-first-call', '127.0.0.1');
  const { wasCacheHit } = applySystemPromptCache(makeReq('You are a helpful assistant.'), session);
  assert.equal(wasCacheHit, false);
});

test('first call — system is converted to block array with cache_control', () => {
  const session = getOrCreateSession('cache-block-format', '127.0.0.1');
  const { request } = applySystemPromptCache(makeReq('Be concise.'), session);
  assert.ok(Array.isArray(request.system));
  const blocks = request.system as Array<{ type: string; text: string; cache_control?: unknown }>;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, 'Be concise.');
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
});

test('second call with same system — cache hit', () => {
  const session = getOrCreateSession('cache-hit', '127.0.0.1');
  applySystemPromptCache(makeReq('Prompt ABC'), session);
  const { wasCacheHit } = applySystemPromptCache(makeReq('Prompt ABC'), session);
  assert.equal(wasCacheHit, true);
});

test('different system prompt — not a hit', () => {
  const session = getOrCreateSession('cache-miss', '127.0.0.1');
  applySystemPromptCache(makeReq('Prompt X'), session);
  const { wasCacheHit } = applySystemPromptCache(makeReq('Prompt Y'), session);
  assert.equal(wasCacheHit, false);
});

test('system as content block array — extracted and hashed correctly', () => {
  const session = getOrCreateSession('cache-block-input', '127.0.0.1');
  const blockSystem = [{ type: 'text', text: 'Block system prompt.' }];
  const stringSystem = 'Block system prompt.';

  const req1: AnthropicRequest = { model: 'claude-sonnet-4-6', max_tokens: 32, system: blockSystem, messages: [] };
  const req2: AnthropicRequest = { model: 'claude-sonnet-4-6', max_tokens: 32, system: stringSystem, messages: [] };

  applySystemPromptCache(req1, session);
  // Same text, different input format → should be a cache hit
  const { wasCacheHit } = applySystemPromptCache(req2, session);
  assert.equal(wasCacheHit, true);
});

test('different sessions are independent', () => {
  const s1 = getOrCreateSession('cache-session-A', '127.0.0.1');
  const s2 = getOrCreateSession('cache-session-B', '127.0.0.1');
  applySystemPromptCache(makeReq('Shared prompt'), s1);
  const { wasCacheHit } = applySystemPromptCache(makeReq('Shared prompt'), s2);
  assert.equal(wasCacheHit, false);
});
