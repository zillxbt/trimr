import Fastify from 'fastify';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getOrCreateSession, getAllSessions, getTotalTokensSaved, hashApiKey } from './session.js';
import { applySystemPromptCache, type AnthropicRequest, type AnthropicMessage, type ContentBlock } from './pipeline/cache.js';
import { applyFileDiffing } from './pipeline/differ.js';
import { applyConversationSummarisation } from './pipeline/summariser.js';
import { checkDedup, storeDedup, checkStreamDedup, storeStreamDedup } from './pipeline/dedup.js';
import { loadHistory, flushHistory, getHistory } from './persistence.js';
import { estimateTokens } from './pricing.js';
import { startDashboard, log } from './dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = readFileSync(join(__dirname, 'web/dashboard.html'), 'utf8');

const PORT = parseInt(process.env.PORT ?? '8787', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const OPENAI_BASE = 'https://api.openai.com';
const USE_DASHBOARD = process.env.TOKENDIFF_DASHBOARD !== 'false';

const startTime = Date.now();

// ── Fastify setup ─────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: false, trustProxy: true });

// Parse JSON bodies; also accept plain string fallback for pass-through routes
fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error, undefined);
    }
  },
);

// ── Auth helper ───────────────────────────────────────────────────────────────

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/** Resolve the API key for a request. Bearer token takes priority, then x-api-key header, then env var. */
function resolveApiKey(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const bearer = extractBearerToken(req.headers['authorization'] as string | undefined);
  if (bearer) return bearer;
  const xApiKey = req.headers['x-api-key'] as string | undefined;
  if (xApiKey) return xApiKey;
  if (ANTHROPIC_API_KEY) return ANTHROPIC_API_KEY;
  return null;
}

/** Resolve session ID: explicit header > API key hash */
function resolveSessionId(req: { headers: Record<string, string | string[] | undefined> }, apiKey: string): string {
  const explicit = req.headers['x-tokendiff-session'] as string | undefined;
  if (explicit) return explicit;
  return `key:${hashApiKey(apiKey)}`;
}

// ── Fetch with exponential-backoff retry on 429 ───────────────────────────────

async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      if (attempt === maxRetries) throw e;
      const delay = Math.pow(2, attempt) * 1000;
      log(`[upstream] network error attempt ${attempt + 1}: ${(e as Error).message}, retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (res.status !== 429 || attempt === maxRetries) return res;

    const retryAfter = res.headers.get('retry-after');
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, attempt) * 1000;
    log(`[upstream] 429 rate-limited, retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error('fetchWithRetry: unexpected exit');
}

// ── Health endpoint ───────────────────────────────────────────────────────────

fastify.get('/health', async (_req, _reply) => {
  const history = getHistory();
  return {
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    totalTokensSaved: getTotalTokensSaved() + (history.lifetime?.tokensSaved ?? 0),
    activeSessions: getAllSessions().length,
    environment: NODE_ENV,
  };
});

// ── Web dashboard ─────────────────────────────────────────────────────────────

fastify.get('/tokendiff', async (_req, reply) => {
  return reply.header('content-type', 'text/html; charset=utf-8').send(DASHBOARD_HTML);
});

fastify.get('/tokendiff/', async (_req, reply) => {
  return reply.header('content-type', 'text/html; charset=utf-8').send(DASHBOARD_HTML);
});

// ── Stats endpoint (used by dashboard polling) ────────────────────────────────

fastify.get('/tokendiff/stats', async (_req, _reply) => {
  return {
    history: getHistory(),
    sessions: getAllSessions().map((s) => ({
      id: s.id,
      requestCount: s.stats.requestCount,
      tokensOriginal: s.stats.tokensOriginal,
      tokensSaved: s.stats.tokensSaved,
      cacheHits: s.stats.cacheHits,
      diffsSent: s.stats.diffsSent,
      summariesDone: s.stats.summariesDone,
      dedupHits: s.stats.dedupHits,
      realInputTokens: s.stats.realInputTokens,
      outputTokens: s.stats.outputTokens,
      cacheReadTokens: s.stats.cacheReadTokens,
      lastActivity: s.lastActivity,
    })),
  };
});

// ── Shared pipeline logic ─────────────────────────────────────────────────────

async function runPipeline(
  body: AnthropicRequest,
  apiKey: string,
  sessionId: string,
  disabled: Set<string>,
): Promise<{
  body: AnthropicRequest;
  session: ReturnType<typeof getOrCreateSession>;
  originalReq: AnthropicRequest;
  originalTokens: number;
  dedupJsonHit?: unknown;
  dedupStreamHit?: Buffer;
}> {
  const session = getOrCreateSession(sessionId);
  session.stats.requestCount++;

  const originalReq = structuredClone(body);
  const originalTokens = estimateTokens(JSON.stringify(body));

  // Dedup check
  if (!disabled.has('dedup')) {
    if (body.stream) {
      const cached = checkStreamDedup(originalReq);
      if (cached) {
        session.stats.dedupHits++;
        session.stats.tokensOriginal += originalTokens;
        session.stats.tokensSaved += originalTokens;
        log(`[${sessionId.slice(0, 12)}] stream dedup hit — replaying cached stream`);
        return { body, session, originalReq, originalTokens, dedupStreamHit: cached.bytes };
      }
    } else {
      const cached = checkDedup(originalReq);
      if (cached) {
        session.stats.dedupHits++;
        session.stats.tokensOriginal += originalTokens;
        session.stats.tokensSaved += originalTokens;
        log(`[${sessionId.slice(0, 12)}] dedup cache hit — returning stored response`);
        return { body, session, originalReq, originalTokens, dedupJsonHit: cached.response };
      }
    }
  }

  // Step 1 — System prompt caching
  if (!disabled.has('cache')) {
    try {
      const { request, wasCacheHit } = applySystemPromptCache(body, session);
      body = request;
      if (wasCacheHit) {
        session.stats.cacheHits++;
        log(`[${sessionId.slice(0, 12)}] cache hit on system prompt`);
      }
    } catch (e) {
      log(`[pipeline/cache] ${(e as Error).message}`);
    }
  }

  // Step 2 — File content diffing
  if (!disabled.has('diff')) {
    try {
      const { messages, tokensSaved, diffCount } = applyFileDiffing(body.messages, session);
      body = { ...body, messages };
      if (diffCount > 0) {
        session.stats.diffsSent += diffCount;
        log(`[${sessionId.slice(0, 12)}] ${diffCount} file diff(s), saved ~${tokensSaved} tokens`);
      }
    } catch (e) {
      log(`[pipeline/differ] ${(e as Error).message}`);
    }
  }

  // Step 3 — Conversation summarisation
  if (!disabled.has('summarise')) {
    try {
      const { messages, summarised, tokensSaved } = await applyConversationSummarisation(
        body.messages,
        apiKey,
      );
      body = { ...body, messages };
      if (summarised) {
        session.stats.summariesDone++;
        log(`[${sessionId.slice(0, 12)}] history summarised, saved ~${tokensSaved} tokens`);
      }
    } catch (e) {
      log(`[pipeline/summariser] ${(e as Error).message}`);
    }
  }

  // Track savings
  const processedTokens = estimateTokens(JSON.stringify(body));
  session.stats.tokensOriginal += originalTokens;
  session.stats.tokensSaved += Math.max(0, originalTokens - processedTokens);

  return { body, session, originalReq, originalTokens };
}

// ── Main /v1/messages proxy (Anthropic) ───────────────────────────────────────

fastify.post('/v1/messages', async (req, reply) => {
  const apiKey = resolveApiKey(req);
  if (!apiKey) {
    return reply.status(401).send({
      type: 'error',
      error: { type: 'authentication_error', message: 'No API key — pass Authorization: Bearer <key>, x-api-key header, or set ANTHROPIC_API_KEY env var' },
    });
  }

  const disabled = new Set(
    ((req.headers['x-tokendiff-disable'] as string) ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  );
  if (disabled.size > 0) {
    log(`[pipeline] disabled stages: ${[...disabled].join(', ')}`);
  }

  const sessionId = resolveSessionId(req, apiKey);
  let body = req.body as AnthropicRequest;

  const result = await runPipeline(body, apiKey, sessionId, disabled);
  body = result.body;
  const { session, originalReq } = result;

  // Dedup hits — return cached response
  if (result.dedupStreamHit) {
    reply.raw.statusCode = 200;
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.setHeader('x-tokendiff-cache', 'hit');
    reply.raw.write(result.dedupStreamHit);
    reply.raw.end();
    return reply;
  }
  if (result.dedupJsonHit) {
    return reply.header('x-tokendiff-cache', 'hit').send(result.dedupJsonHit);
  }

  // Build upstream headers
  const upstreamHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version':
      (req.headers['anthropic-version'] as string | undefined) ?? '2023-06-01',
  };

  const hasCacheControl =
    Array.isArray(body.system) &&
    body.system.some((b: { cache_control?: unknown }) => b.cache_control);

  const clientBeta = req.headers['anthropic-beta'] as string | undefined;
  if (hasCacheControl) {
    const betaValues = new Set<string>(['prompt-caching-2024-07-31']);
    if (clientBeta) clientBeta.split(',').map((s) => s.trim()).forEach((v) => betaValues.add(v));
    upstreamHeaders['anthropic-beta'] = [...betaValues].join(',');
  } else if (clientBeta) {
    upstreamHeaders['anthropic-beta'] = clientBeta;
  }

  // Forward to Anthropic
  let anthropicRes: Response;
  try {
    anthropicRes = await fetchWithRetry(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (e) {
    log(`[upstream] fetch error: ${(e as Error).message}`);
    return reply.status(502).send({ type: 'error', error: { message: 'Upstream unreachable' } });
  }

  if (body.stream) {
    // Streaming passthrough
    reply.raw.statusCode = anthropicRes.status;
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    for (const [k, v] of anthropicRes.headers.entries()) {
      if (k.startsWith('x-') || k === 'anthropic-ratelimit-requests-remaining') {
        reply.raw.setHeader(k, v);
      }
    }

    if (anthropicRes.body) {
      const reader = anthropicRes.body.getReader();
      const shouldCache = !disabled.has('dedup') && anthropicRes.status === 200;
      const chunks: Buffer[] = [];

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            if (shouldCache) chunks.push(chunk);
            reply.raw.write(chunk);
          }
          if (shouldCache && chunks.length > 0) {
            storeStreamDedup(originalReq, Buffer.concat(chunks));
          }
        } catch (e) {
          log(`[stream] error: ${(e as Error).message}`);
        } finally {
          reply.raw.end();
        }
      })();
    } else {
      reply.raw.end();
    }

    return reply;
  } else {
    // Non-streaming
    const data = await anthropicRes.json() as {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

    if (data.usage) {
      const realInput = data.usage.input_tokens ?? 0;
      const realOutput = data.usage.output_tokens ?? 0;
      const cacheRead = data.usage.cache_read_input_tokens ?? 0;

      session.stats.realInputTokens += realInput;
      session.stats.outputTokens += realOutput;
      session.stats.cacheReadTokens += cacheRead;

      session.stats.tokensSaved = Math.max(0,
        session.stats.tokensOriginal - session.stats.realInputTokens,
      );
    }

    if (!disabled.has('dedup') && anthropicRes.status === 200) {
      storeDedup(originalReq, data);
    }

    return reply.status(anthropicRes.status).send(data);
  }
});

// ── OpenAI-compatible proxy at /openai/* ──────────────────────────────────────

interface OpenAIMessage {
  role: string;
  content: string | null;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  [key: string]: unknown;
}

/** Convert OpenAI chat request to Anthropic format for pipeline processing */
function openaiToAnthropic(oaiReq: OpenAIChatRequest): AnthropicRequest {
  const messages: AnthropicMessage[] = [];
  let systemText = '';

  for (const msg of oaiReq.messages) {
    if (msg.role === 'system') {
      systemText += (systemText ? '\n' : '') + (msg.content ?? '');
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: msg.content ?? '' });
    }
  }

  // Anthropic requires alternating user/assistant. If first message is assistant, prepend empty user.
  if (messages.length > 0 && messages[0].role === 'assistant') {
    messages.unshift({ role: 'user', content: '(continued)' });
  }

  const req: AnthropicRequest = {
    model: oaiReq.model,
    max_tokens: oaiReq.max_tokens ?? 4096,
    messages,
    stream: oaiReq.stream,
  };

  if (systemText) {
    req.system = systemText;
  }
  if (oaiReq.temperature !== undefined) {
    req.temperature = oaiReq.temperature;
  }

  return req;
}

fastify.post('/openai/v1/chat/completions', async (req, reply) => {
  const apiKey = resolveApiKey(req);
  if (!apiKey) {
    return reply.status(401).send({
      error: { message: 'No API key — pass Authorization: Bearer <key>', type: 'authentication_error', code: 401 },
    });
  }

  const disabled = new Set(
    ((req.headers['x-tokendiff-disable'] as string) ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  );

  const sessionId = resolveSessionId(req, apiKey);
  const oaiBody = req.body as OpenAIChatRequest;

  // Convert to Anthropic format for pipeline
  let anthropicBody = openaiToAnthropic(oaiBody);

  const result = await runPipeline(anthropicBody, apiKey, sessionId, disabled);
  anthropicBody = result.body;

  // Forward to OpenAI in original format, applying pipeline savings back
  // Rebuild the OpenAI messages from the processed Anthropic body
  const processedOaiMessages: OpenAIMessage[] = [];

  // Re-add system if present
  if (anthropicBody.system) {
    const sysText = typeof anthropicBody.system === 'string'
      ? anthropicBody.system
      : anthropicBody.system.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
    processedOaiMessages.push({ role: 'system', content: sysText });
  }

  for (const msg of anthropicBody.messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : (msg.content as ContentBlock[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('');
    processedOaiMessages.push({ role: msg.role, content });
  }

  const processedOaiBody = {
    ...oaiBody,
    messages: processedOaiMessages,
    model: oaiBody.model,
  };

  // Build upstream headers for OpenAI
  const upstreamHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'authorization': `Bearer ${apiKey}`,
  };

  let openaiRes: Response;
  try {
    openaiRes = await fetchWithRetry(`${OPENAI_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(processedOaiBody),
    });
  } catch (e) {
    log(`[openai upstream] fetch error: ${(e as Error).message}`);
    return reply.status(502).send({ error: { message: 'OpenAI upstream unreachable' } });
  }

  if (oaiBody.stream) {
    reply.raw.statusCode = openaiRes.status;
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');

    if (openaiRes.body) {
      const reader = openaiRes.body.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            reply.raw.write(Buffer.from(value));
          }
        } catch (e) {
          log(`[openai stream] error: ${(e as Error).message}`);
        } finally {
          reply.raw.end();
        }
      })();
    } else {
      reply.raw.end();
    }
    return reply;
  } else {
    const data = await openaiRes.json();
    return reply.status(openaiRes.status).send(data);
  }
});

// ── Passthrough for all other /v1/* endpoints (Anthropic) ─────────────────────

fastify.all('/v1/*', { config: {} }, async (req, reply) => {
  const apiKey = resolveApiKey(req);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey ?? '',
    'anthropic-version':
      (req.headers['anthropic-version'] as string | undefined) ?? '2023-06-01',
  };

  const rawBody =
    req.body != null
      ? typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body)
      : undefined;

  const res = await fetch(`${ANTHROPIC_BASE}${req.url}`, {
    method: req.method,
    headers,
    body: rawBody,
  });

  const data = await res.json();
  return reply.status(res.status).send(data);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`[shutdown] received ${signal}, closing gracefully...`);

  // Flush stats to disk
  flushHistory(getAllSessions());

  // Close server (stop accepting new connections, wait for in-flight)
  try {
    await fastify.close();
  } catch {
    // Best effort
  }

  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => shutdown(sig));
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });

  loadHistory();

  // Flush stats to disk every 30s
  setInterval(() => flushHistory(getAllSessions()), 30_000).unref();

  if (USE_DASHBOARD && NODE_ENV !== 'production') {
    startDashboard(PORT);
  } else {
    console.log(`Trimr proxy running on http://0.0.0.0:${PORT} [${NODE_ENV}]`);
    console.log('Pass Authorization: Bearer <api-key> or set ANTHROPIC_API_KEY env var.');
  }
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
