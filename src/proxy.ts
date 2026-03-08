import Fastify from 'fastify';
import { TLSSocket } from 'tls';
import { connect as netConnect } from 'net';
import { createServer as createHttpServer } from 'http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Duplex } from 'stream';
import { getOrCreateSession, getAllSessions, getTotalTokensSaved, hashApiKey } from './session.js';
import { applySystemPromptCache, type AnthropicRequest, type AnthropicMessage, type ContentBlock } from './pipeline/cache.js';
import { applyFileDiffing } from './pipeline/differ.js';
import { applyConversationSummarisation } from './pipeline/summariser.js';
import { checkDedup, storeDedup, checkStreamDedup, storeStreamDedup } from './pipeline/dedup.js';
import { loadHistory, flushHistory, getHistory } from './persistence.js';
import { estimateTokens } from './pricing.js';
import { startDashboard, log } from './dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dashboard HTML — try multiple locations
let DASHBOARD_HTML = '';
for (const candidate of [
  join(__dirname, 'web/dashboard.html'),
  join(__dirname, '../src/web/dashboard.html'),
]) {
  try { DASHBOARD_HTML = readFileSync(candidate, 'utf8'); break; } catch { /* try next */ }
}

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? '3000', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const USE_DASHBOARD = process.env.TOKENDIFF_DASHBOARD !== 'false';

const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
const OPENAI_UPSTREAM = 'https://api.openai.com';

const INTERCEPTED_DOMAINS = ['api.anthropic.com', 'api.openai.com'];

// Domains that must NEVER be intercepted — plain TCP tunnel only, zero modification.
// This prevents auth/login failures for tools that route through this proxy.
const PASSTHROUGH_DOMAINS = [
  'api2.cursor.sh',
  'cursor.sh',
  'marketplace.cursorapi.com',
  'metrics.cursor.sh',
];
const PASSTHROUGH_SUFFIXES = ['.cursor.sh', '.cursorapi.com'];

const startTime = Date.now();

// ── Debug request capture ──────────────────────────────────────────────────
const DEBUG_REQ_PATH = join(homedir(), '.trimr', 'debug-requests.json');
let debugReqCount = 0;
const MAX_DEBUG_REQS = 3;

function captureDebugRequest(body: unknown, source: string): void {
  if (debugReqCount >= MAX_DEBUG_REQS) return;
  debugReqCount++;
  try {
    mkdirSync(join(homedir(), '.trimr'), { recursive: true });
    let existing: unknown[] = [];
    try { existing = JSON.parse(readFileSync(DEBUG_REQ_PATH, 'utf8')); } catch { /* */ }
    const req = body as Record<string, unknown>;
    // Summarize messages to avoid huge dumps
    const messages = (req.messages as Array<{ role: string; content: unknown }>) ?? [];
    const messageSummary = messages.map((m, i) => {
      const contentDesc = typeof m.content === 'string'
        ? { type: 'string', length: m.content.length, preview: m.content.slice(0, 200) }
        : Array.isArray(m.content)
          ? (m.content as Array<Record<string, unknown>>).map(b => ({
              type: b.type,
              ...(b.type === 'text' ? { textLength: (b.text as string)?.length, preview: (b.text as string)?.slice(0, 200) } : {}),
              ...(b.type === 'tool_use' ? { name: b.name, id: b.id, inputKeys: Object.keys(b.input as Record<string, unknown> ?? {}) } : {}),
              ...(b.type === 'tool_result' ? {
                tool_use_id: b.tool_use_id,
                contentType: typeof b.content,
                contentLength: typeof b.content === 'string' ? b.content.length : Array.isArray(b.content) ? (b.content as unknown[]).length : 0,
                contentPreview: typeof b.content === 'string' ? b.content.slice(0, 300) : undefined,
              } : {}),
            }))
          : { type: typeof m.content };
      return { index: i, role: m.role, content: contentDesc };
    });

    existing.push({
      captureIndex: debugReqCount,
      source,
      timestamp: new Date().toISOString(),
      model: req.model,
      stream: req.stream,
      systemType: typeof req.system,
      systemIsArray: Array.isArray(req.system),
      messageCount: messages.length,
      messages: messageSummary,
    });
    writeFileSync(DEBUG_REQ_PATH, JSON.stringify(existing, null, 2));
    log(`[debug] captured request ${debugReqCount}/${MAX_DEBUG_REQS} to ${DEBUG_REQ_PATH}`);
  } catch (e) {
    log(`[debug] capture error: ${(e as Error).message}`);
  }
}

// ── Cert loading for CONNECT MITM (optional) ──────────────────────────────────

function loadMitmCerts(): Map<string, { key: string; cert: string }> | null {
  const certDir = join(homedir(), '.trimr', 'certs');
  const certs = new Map<string, { key: string; cert: string }>();

  for (const domain of INTERCEPTED_DOMAINS) {
    const keyPath = join(certDir, `${domain}.key`);
    const certPath = join(certDir, `${domain}.pem`);
    if (!existsSync(keyPath) || !existsSync(certPath)) {
      return null;
    }
    certs.set(domain, {
      key: readFileSync(keyPath, 'utf8'),
      cert: readFileSync(certPath, 'utf8'),
    });
  }

  return certs;
}

// ── Fastify setup ─────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: false, trustProxy: true });

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

// ── Debug: log every incoming request ─────────────────────────────────────────

fastify.addHook('onRequest', async (req, _reply) => {
  log(`[req] ${req.method} ${req.url} (from ${req.ip})`);
});

// ── Auth helper ───────────────────────────────────────────────────────────────

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function resolveApiKey(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const bearer = extractBearerToken(req.headers['authorization'] as string | undefined);
  if (bearer) return bearer;
  const xApiKey = req.headers['x-api-key'] as string | undefined;
  if (xApiKey) return xApiKey;
  if (ANTHROPIC_API_KEY) return ANTHROPIC_API_KEY;
  return null;
}

function resolveSessionId(req: { headers: Record<string, string | string[] | undefined> }, apiKey: string): string {
  const explicit = req.headers['x-tokendiff-session'] as string | undefined;
  if (explicit) return explicit;
  return `key:${hashApiKey(apiKey)}`;
}

// ── Fetch with retry on 429 ──────────────────────────────────────────────────

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
    mode: 'connect-proxy',
  };
});

// ── Web dashboard ─────────────────────────────────────────────────────────────

fastify.get('/tokendiff', async (_req, reply) => {
  return reply.header('content-type', 'text/html; charset=utf-8').send(DASHBOARD_HTML);
});

fastify.get('/tokendiff/', async (_req, reply) => {
  return reply.header('content-type', 'text/html; charset=utf-8').send(DASHBOARD_HTML);
});

fastify.get('/', async (_req, reply) => {
  if (DASHBOARD_HTML) {
    return reply.header('content-type', 'text/html; charset=utf-8').send(DASHBOARD_HTML);
  }
  return reply.send({ name: 'trimr', mode: 'connect-proxy' });
});

// ── Stats endpoint ────────────────────────────────────────────────────────────

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

  // Capture first N requests for debugging
  captureDebugRequest(body, 'runPipeline');

  const originalReq = structuredClone(body);
  const originalTokens = estimateTokens(JSON.stringify(body));

  if (!disabled.has('dedup')) {
    if (body.stream) {
      const cached = checkStreamDedup(originalReq);
      if (cached) {
        session.stats.dedupHits++;
        session.stats.tokensOriginal += originalTokens;
        session.stats.tokensSaved += originalTokens;
        log(`[${sessionId.slice(0, 12)}] stream dedup hit`);
        return { body, session, originalReq, originalTokens, dedupStreamHit: cached.bytes };
      }
    } else {
      const cached = checkDedup(originalReq);
      if (cached) {
        session.stats.dedupHits++;
        session.stats.tokensOriginal += originalTokens;
        session.stats.tokensSaved += originalTokens;
        log(`[${sessionId.slice(0, 12)}] dedup hit`);
        return { body, session, originalReq, originalTokens, dedupJsonHit: cached.response };
      }
    }
  }

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

  if (!disabled.has('diff')) {
    try {
      const { messages, tokensSaved, diffCount } = applyFileDiffing(body.messages, session);
      body = { ...body, messages };
      if (diffCount > 0) {
        session.stats.diffsSent += diffCount;
        log(`[${sessionId.slice(0, 12)}] ${diffCount} diff(s), saved ~${tokensSaved} tokens`);
      }
    } catch (e) {
      log(`[pipeline/differ] ${(e as Error).message}`);
    }
  }

  if (!disabled.has('summarise')) {
    try {
      const { messages, summarised, tokensSaved } = await applyConversationSummarisation(
        body.messages, apiKey,
      );
      body = { ...body, messages };
      if (summarised) {
        session.stats.summariesDone++;
        log(`[${sessionId.slice(0, 12)}] summarised, saved ~${tokensSaved} tokens`);
      }
    } catch (e) {
      log(`[pipeline/summariser] ${(e as Error).message}`);
    }
  }

  const processedTokens = estimateTokens(JSON.stringify(body));
  session.stats.tokensOriginal += originalTokens;
  session.stats.tokensSaved += Math.max(0, originalTokens - processedTokens);

  return { body, session, originalReq, originalTokens };
}

// ── Anthropic /v1/messages proxy (HTTP forward mode) ──────────────────────────

fastify.post('/v1/messages', async (req, reply) => {
  const apiKey = resolveApiKey(req);
  if (!apiKey) {
    return reply.status(401).send({
      type: 'error',
      error: { type: 'authentication_error', message: 'No API key provided' },
    });
  }

  const disabled = new Set(
    ((req.headers['x-tokendiff-disable'] as string) ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  );

  const sessionId = resolveSessionId(req, apiKey);
  let body = req.body as AnthropicRequest;
  const originalBody = body;

  try {
    let result: Awaited<ReturnType<typeof runPipeline>> | null = null;
    try {
      result = await runPipeline(body, apiKey, sessionId, disabled);
      body = result.body;
    } catch (e) {
      log(`[pipeline] PASSTHROUGH due to error: ${(e as Error).message}`);
      body = originalBody;
    }

    const session = result?.session ?? null;
    const originalReq = result?.originalReq ?? originalBody;

    if (result?.dedupStreamHit) {
      reply.raw.statusCode = 200;
      reply.raw.setHeader('content-type', 'text/event-stream');
      reply.raw.setHeader('cache-control', 'no-cache');
      reply.raw.setHeader('x-trimr-cache', 'hit');
      reply.raw.write(result.dedupStreamHit);
      reply.raw.end();
      return reply;
    }
    if (result?.dedupJsonHit) {
      return reply.header('x-trimr-cache', 'hit').send(result.dedupJsonHit);
    }

    const upstreamHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': (req.headers['anthropic-version'] as string | undefined) ?? '2023-06-01',
    };

    const hasCacheControl = Array.isArray(body.system) &&
      body.system.some((b: { cache_control?: unknown }) => b.cache_control);
    const clientBeta = req.headers['anthropic-beta'] as string | undefined;
    if (hasCacheControl) {
      const betaValues = new Set<string>(['prompt-caching-2024-07-31']);
      if (clientBeta) clientBeta.split(',').map((s) => s.trim()).forEach((v) => betaValues.add(v));
      upstreamHeaders['anthropic-beta'] = [...betaValues].join(',');
    } else if (clientBeta) {
      upstreamHeaders['anthropic-beta'] = clientBeta;
    }

    let anthropicRes: Response;
    try {
      anthropicRes = await fetchWithRetry(`${ANTHROPIC_UPSTREAM}/v1/messages`, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(body),
      });
    } catch (e) {
      log(`[upstream] fetch error: ${(e as Error).message}`);
      return reply.status(502).send({ type: 'error', error: { message: 'Upstream unreachable' } });
    }

    // If Anthropic returns 400 and we modified the body, retry with the original unmodified request
    if (anthropicRes.status === 400 && body !== originalBody) {
      log(`[upstream] 400 from Anthropic after pipeline — retrying with original body`);
      const retryHeaders: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': (req.headers['anthropic-version'] as string | undefined) ?? '2023-06-01',
      };
      const retryBeta = req.headers['anthropic-beta'] as string | undefined;
      if (retryBeta) retryHeaders['anthropic-beta'] = retryBeta;
      try {
        anthropicRes = await fetchWithRetry(`${ANTHROPIC_UPSTREAM}/v1/messages`, {
          method: 'POST',
          headers: retryHeaders,
          body: JSON.stringify(originalBody),
        });
        body = originalBody;
      } catch (e2) {
        log(`[upstream] retry also failed: ${(e2 as Error).message}`);
        return reply.status(502).send({ type: 'error', error: { message: 'Upstream unreachable' } });
      }
    }

    if (body.stream) {
      reply.raw.statusCode = anthropicRes.status;
      reply.raw.setHeader('content-type', 'text/event-stream');
      reply.raw.setHeader('cache-control', 'no-cache');
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
      const data = await anthropicRes.json() as {
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      };

      if (data.usage && session) {
        session.stats.realInputTokens += data.usage.input_tokens ?? 0;
        session.stats.outputTokens += data.usage.output_tokens ?? 0;
        session.stats.cacheReadTokens += data.usage.cache_read_input_tokens ?? 0;
        session.stats.tokensSaved = Math.max(0,
          session.stats.tokensOriginal - session.stats.realInputTokens);
      }

      if (!disabled.has('dedup') && anthropicRes.status === 200) {
        storeDedup(originalReq, data);
      }

      return reply.status(anthropicRes.status).send(data);
    }
  } catch (topLevelErr) {
    // Top-level safety net: if ANYTHING in the pipeline or upstream handling throws,
    // bypass everything and send the original request directly to Anthropic.
    log(`[FAILSAFE] unexpected error, bypassing pipeline entirely: ${(topLevelErr as Error).message}`);
    const passthroughHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': (req.headers['anthropic-version'] as string | undefined) ?? '2023-06-01',
    };
    const clientBeta = req.headers['anthropic-beta'] as string | undefined;
    if (clientBeta) passthroughHeaders['anthropic-beta'] = clientBeta;

    try {
      const fallbackRes = await fetch(`${ANTHROPIC_UPSTREAM}/v1/messages`, {
        method: 'POST',
        headers: passthroughHeaders,
        body: JSON.stringify(originalBody),
      });

      if (originalBody.stream) {
        reply.raw.statusCode = fallbackRes.status;
        reply.raw.setHeader('content-type', 'text/event-stream');
        reply.raw.setHeader('cache-control', 'no-cache');
        if (fallbackRes.body) {
          const reader = fallbackRes.body.getReader();
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                reply.raw.write(Buffer.from(value));
              }
            } catch { /* */ } finally {
              reply.raw.end();
            }
          })();
        } else {
          reply.raw.end();
        }
        return reply;
      } else {
        const data = await fallbackRes.json();
        return reply.status(fallbackRes.status).send(data);
      }
    } catch (e2) {
      log(`[FAILSAFE] passthrough also failed: ${(e2 as Error).message}`);
      return reply.status(502).send({ type: 'error', error: { message: 'Upstream unreachable' } });
    }
  }
});

// ── OpenAI /v1/chat/completions proxy ─────────────────────────────────────────

interface OpenAIMessage { role: string; content: string | null; }
interface OpenAIChatRequest {
  model: string; messages: OpenAIMessage[]; max_tokens?: number;
  temperature?: number; stream?: boolean; [key: string]: unknown;
}

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

  if (messages.length > 0 && messages[0].role === 'assistant') {
    messages.unshift({ role: 'user', content: '(continued)' });
  }

  const req: AnthropicRequest = {
    model: oaiReq.model, max_tokens: oaiReq.max_tokens ?? 4096,
    messages, stream: oaiReq.stream,
  };
  if (systemText) req.system = systemText;
  if (oaiReq.temperature !== undefined) req.temperature = oaiReq.temperature;
  return req;
}

for (const path of ['/v1/chat/completions', '/openai/v1/chat/completions']) {
  fastify.post(path, async (req, reply) => {
    const apiKey = resolveApiKey(req);
    if (!apiKey) {
      return reply.status(401).send({
        error: { message: 'No API key', type: 'authentication_error', code: 401 },
      });
    }

    const disabled = new Set(
      ((req.headers['x-tokendiff-disable'] as string) ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean),
    );

    const sessionId = resolveSessionId(req, apiKey);
    const oaiBody = req.body as OpenAIChatRequest;
    let anthropicBody = openaiToAnthropic(oaiBody);

    const result = await runPipeline(anthropicBody, apiKey, sessionId, disabled);
    anthropicBody = result.body;

    const processedMessages: OpenAIMessage[] = [];
    if (anthropicBody.system) {
      const sysText = typeof anthropicBody.system === 'string'
        ? anthropicBody.system
        : anthropicBody.system.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
      processedMessages.push({ role: 'system', content: sysText });
    }
    for (const msg of anthropicBody.messages) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : (msg.content as ContentBlock[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('');
      processedMessages.push({ role: msg.role, content });
    }

    const processedBody = { ...oaiBody, messages: processedMessages };

    let openaiRes: Response;
    try {
      openaiRes = await fetchWithRetry(`${OPENAI_UPSTREAM}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(processedBody),
      });
    } catch (e) {
      log(`[openai upstream] error: ${(e as Error).message}`);
      return reply.status(502).send({ error: { message: 'OpenAI upstream unreachable' } });
    }

    if (oaiBody.stream) {
      reply.raw.statusCode = openaiRes.status;
      reply.raw.setHeader('content-type', 'text/event-stream');
      reply.raw.setHeader('cache-control', 'no-cache');
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
}

// ── Passthrough for other /v1/* (Anthropic) ───────────────────────────────────

fastify.all('/v1/*', { config: {} }, async (req, reply) => {
  const apiKey = resolveApiKey(req);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey ?? '',
    'anthropic-version': (req.headers['anthropic-version'] as string | undefined) ?? '2023-06-01',
  };

  const rawBody = req.body != null
    ? typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    : undefined;

  const res = await fetch(`${ANTHROPIC_UPSTREAM}${req.url}`, { method: req.method, headers, body: rawBody });
  const data = await res.json();
  return reply.status(res.status).send(data);
});

// ── Catch-all: log any unrecognised requests ─────────────────────────────────

fastify.all('*', async (req, reply) => {
  const safeHeaders = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) =>
      /^(authorization|x-api-key|cookie)$/i.test(k) ? [k, '[REDACTED]'] : [k, v],
    ),
  );
  log(`[catch-all] unrecognised route: ${req.method} ${req.url} — headers: ${JSON.stringify(safeHeaders)}`);
  return reply.status(404).send({
    type: 'error',
    error: {
      type: 'not_found',
      message: `TokenDiff proxy has no handler for ${req.method} ${req.url}. ` +
        `Supported: POST /v1/messages, POST /v1/chat/completions, GET /health, GET /tokendiff`,
    },
  });
});

// ── CONNECT tunnel handler ────────────────────────────────────────────────────
// Handles HTTP CONNECT requests from clients using HTTPS_PROXY.
// For intercepted domains (with certs): MITM TLS, run pipeline, forward.
// For other domains (or no certs): plain TCP tunnel passthrough.

function isPassthroughDomain(hostname: string): boolean {
  if (PASSTHROUGH_DOMAINS.includes(hostname)) return true;
  return PASSTHROUGH_SUFFIXES.some(suffix => hostname.endsWith(suffix));
}

function handleConnect(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  mitmCerts: Map<string, { key: string; cert: string }> | null,
): void {
  const [hostname, portStr] = (req.url ?? '').split(':');
  const port = parseInt(portStr ?? '443', 10);
  log(`[connect] CONNECT request for ${hostname}:${port}`);

  // Passthrough-whitelisted domains: always tunnel, never intercept
  if (isPassthroughDomain(hostname)) {
    log(`[connect] passthrough whitelisted: ${hostname}`);
    const serverSocket = netConnect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        serverSocket.write(head);
      }
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
      log(`[tunnel] error connecting to ${hostname}:${port}: ${err.message}`);
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* */ }
    });

    clientSocket.on('error', () => {
      try { serverSocket.destroy(); } catch { /* */ }
    });
    return;
  }

  if (INTERCEPTED_DOMAINS.includes(hostname) && mitmCerts?.has(hostname)) {
    // MITM: terminate TLS, run compression pipeline, forward to real API
    const domainCert = mitmCerts.get(hostname)!;

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    const tlsSocket = new TLSSocket(clientSocket, {
      isServer: true,
      key: domainCert.key,
      cert: domainCert.cert,
    });

    if (head.length > 0) {
      tlsSocket.unshift(head);
    }

    handleMitmConnection(tlsSocket, hostname);
  } else {
    // Plain tunnel: just pipe bytes through to the real server
    const serverSocket = netConnect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        serverSocket.write(head);
      }
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
      log(`[tunnel] error connecting to ${hostname}:${port}: ${err.message}`);
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* */ }
    });

    clientSocket.on('error', () => {
      try { serverSocket.destroy(); } catch { /* */ }
    });
  }
}

// ── MITM connection handler ───────────────────────────────────────────────────

function handleMitmConnection(tlsSocket: TLSSocket, hostname: string): void {
  let buffer = Buffer.alloc(0);

  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return; // incomplete headers, wait for more

    const headerStr = buffer.subarray(0, headerEnd).toString();
    const headerLines = headerStr.split('\r\n');
    const [method, path] = headerLines[0].split(' ');

    const headers: Record<string, string> = {};
    for (let i = 1; i < headerLines.length; i++) {
      const colonIdx = headerLines[i].indexOf(':');
      if (colonIdx > 0) {
        const key = headerLines[i].substring(0, colonIdx).trim().toLowerCase();
        const value = headerLines[i].substring(colonIdx + 1).trim();
        headers[key] = value;
      }
    }

    const contentLength = parseInt(headers['content-length'] ?? '0', 10);
    const bodyStart = headerEnd + 4;
    const totalNeeded = bodyStart + contentLength;

    if (buffer.length < totalNeeded) return; // incomplete body

    tlsSocket.removeListener('data', onData);

    const bodyStr = buffer.subarray(bodyStart, totalNeeded).toString();
    const remaining = buffer.subarray(totalNeeded);

    processMitmRequest(method, path, headers, bodyStr, hostname, tlsSocket, remaining);
  };

  tlsSocket.on('data', onData);

  tlsSocket.on('error', (err) => {
    log(`[mitm] TLS error for ${hostname}: ${err.message}`);
  });
}

async function processMitmRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  bodyStr: string,
  hostname: string,
  tlsSocket: TLSSocket,
  remaining: Buffer,
): Promise<void> {
  const upstream = hostname === 'api.anthropic.com' ? ANTHROPIC_UPSTREAM : OPENAI_UPSTREAM;
  const url = `${upstream}${path}`;

  if (method === 'POST' && path === '/v1/messages' && hostname === 'api.anthropic.com') {
    try {
      await handleMitmAnthropicMessages(headers, bodyStr, tlsSocket);
    } catch (e) {
      log(`[mitm] pipeline error, passing through: ${(e as Error).message}`);
      await passthroughMitm(method, url, headers, bodyStr, hostname, tlsSocket);
    }
  } else {
    await passthroughMitm(method, url, headers, bodyStr, hostname, tlsSocket);
  }

  // Keep-alive: handle subsequent requests on same connection
  if (remaining.length > 0) {
    tlsSocket.unshift(remaining);
  }
  if (!tlsSocket.destroyed) {
    handleMitmConnection(tlsSocket, hostname);
  }
}

async function handleMitmAnthropicMessages(
  headers: Record<string, string>,
  bodyStr: string,
  tlsSocket: TLSSocket,
): Promise<void> {
  let body: AnthropicRequest;
  try {
    body = JSON.parse(bodyStr);
  } catch {
    sendHttpResponse(tlsSocket, 400, { 'content-type': 'application/json' },
      JSON.stringify({ type: 'error', error: { message: 'Invalid JSON' } }));
    return;
  }

  const apiKey = headers['x-api-key']
    ?? headers['authorization']?.replace(/^Bearer\s+/i, '')
    ?? ANTHROPIC_API_KEY;
  if (!apiKey) {
    sendHttpResponse(tlsSocket, 401, { 'content-type': 'application/json' },
      JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'No API key provided' } }));
    return;
  }

  const disabled = new Set(
    (headers['x-tokendiff-disable'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
  );
  const sessionId = headers['x-tokendiff-session'] ?? `key:${hashApiKey(apiKey)}`;
  const originalBody = body;

  let result: Awaited<ReturnType<typeof runPipeline>> | null = null;
  try {
    result = await runPipeline(body, apiKey, sessionId, disabled);
    body = result.body;
  } catch (e) {
    log(`[mitm pipeline] PASSTHROUGH: ${(e as Error).message}`);
    body = originalBody;
  }

  if (result?.dedupStreamHit) {
    sendHttpResponse(tlsSocket, 200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-trimr-cache': 'hit',
    }, result.dedupStreamHit);
    return;
  }
  if (result?.dedupJsonHit) {
    sendHttpResponse(tlsSocket, 200, {
      'content-type': 'application/json',
      'x-trimr-cache': 'hit',
    }, JSON.stringify(result.dedupJsonHit));
    return;
  }

  const upstreamHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': headers['anthropic-version'] ?? '2023-06-01',
  };

  const hasCacheControl = Array.isArray(body.system) &&
    body.system.some((b: { cache_control?: unknown }) => b.cache_control);
  const clientBeta = headers['anthropic-beta'];
  if (hasCacheControl) {
    const bv = new Set<string>(['prompt-caching-2024-07-31']);
    if (clientBeta) clientBeta.split(',').map(s => s.trim()).forEach(v => bv.add(v));
    upstreamHeaders['anthropic-beta'] = [...bv].join(',');
  } else if (clientBeta) {
    upstreamHeaders['anthropic-beta'] = clientBeta;
  }

  let anthropicRes: Response;
  try {
    anthropicRes = await fetchWithRetry(`${ANTHROPIC_UPSTREAM}/v1/messages`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (e) {
    log(`[mitm upstream] error: ${(e as Error).message}`);
    sendHttpResponse(tlsSocket, 502, { 'content-type': 'application/json' },
      JSON.stringify({ type: 'error', error: { message: 'Upstream unreachable' } }));
    return;
  }

  // If Anthropic returns 400 and we modified the body, retry with original unmodified request
  if (anthropicRes.status === 400 && body !== originalBody) {
    log(`[mitm upstream] 400 from Anthropic after pipeline — retrying with original body`);
    const retryHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': headers['anthropic-version'] ?? '2023-06-01',
    };
    const retryBeta = headers['anthropic-beta'];
    if (retryBeta) retryHeaders['anthropic-beta'] = retryBeta;
    try {
      anthropicRes = await fetchWithRetry(`${ANTHROPIC_UPSTREAM}/v1/messages`, {
        method: 'POST',
        headers: retryHeaders,
        body: JSON.stringify(originalBody),
      });
      body = originalBody;
    } catch (e2) {
      log(`[mitm upstream] retry also failed: ${(e2 as Error).message}`);
      sendHttpResponse(tlsSocket, 502, { 'content-type': 'application/json' },
        JSON.stringify({ type: 'error', error: { message: 'Upstream unreachable' } }));
      return;
    }
  }

  if (body.stream) {
    const resHeaders: Record<string, string> = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'transfer-encoding': 'chunked',
    };
    for (const [k, v] of anthropicRes.headers.entries()) {
      if (k.startsWith('x-')) resHeaders[k] = v;
    }
    sendHttpResponseHeaders(tlsSocket, anthropicRes.status, resHeaders);

    if (anthropicRes.body) {
      const reader = anthropicRes.body.getReader();
      const originalReq = result?.originalReq ?? originalBody;
      const shouldCache = !disabled.has('dedup') && anthropicRes.status === 200;
      const chunks: Buffer[] = [];

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          if (shouldCache) chunks.push(chunk);
          writeChunked(tlsSocket, chunk);
        }
        if (shouldCache && chunks.length > 0) {
          storeStreamDedup(originalReq, Buffer.concat(chunks));
        }
      } catch (e) {
        log(`[mitm stream] error: ${(e as Error).message}`);
      }
    }
    writeChunked(tlsSocket, null);
  } else {
    const data = await anthropicRes.text();

    try {
      const parsed = JSON.parse(data);
      if (parsed.usage && result?.session) {
        result.session.stats.realInputTokens += parsed.usage.input_tokens ?? 0;
        result.session.stats.outputTokens += parsed.usage.output_tokens ?? 0;
        result.session.stats.cacheReadTokens += parsed.usage.cache_read_input_tokens ?? 0;
        result.session.stats.tokensSaved = Math.max(0,
          result.session.stats.tokensOriginal - result.session.stats.realInputTokens);
      }
      if (!disabled.has('dedup') && anthropicRes.status === 200) {
        storeDedup(result?.originalReq ?? originalBody, parsed);
      }
    } catch { /* non-JSON response */ }

    sendHttpResponse(tlsSocket, anthropicRes.status, { 'content-type': 'application/json' }, data);
  }
}

async function passthroughMitm(
  method: string,
  url: string,
  headers: Record<string, string>,
  bodyStr: string,
  hostname: string,
  tlsSocket: TLSSocket,
): Promise<void> {
  const upstreamHeaders: Record<string, string> = { ...headers, host: hostname };
  delete upstreamHeaders['transfer-encoding'];

  try {
    const res = await fetch(url, {
      method,
      headers: upstreamHeaders,
      body: method !== 'GET' && method !== 'HEAD' ? bodyStr : undefined,
    });

    const resBody = await res.arrayBuffer();
    const resHeaders: Record<string, string> = {};
    for (const [k, v] of res.headers.entries()) {
      resHeaders[k] = v;
    }
    delete resHeaders['transfer-encoding'];
    resHeaders['content-length'] = String(resBody.byteLength);

    sendHttpResponse(tlsSocket, res.status, resHeaders, Buffer.from(resBody));
  } catch (e) {
    log(`[mitm passthrough] error: ${(e as Error).message}`);
    sendHttpResponse(tlsSocket, 502, { 'content-type': 'text/plain' }, 'Bad Gateway');
  }
}

// ── HTTP response helpers for raw TLS sockets ────────────────────────────────

function sendHttpResponse(
  socket: TLSSocket,
  status: number,
  headers: Record<string, string>,
  body: string | Buffer,
): void {
  const bodyBuf = typeof body === 'string' ? Buffer.from(body) : body;
  headers['content-length'] = String(bodyBuf.length);
  delete headers['transfer-encoding'];

  let head = `HTTP/1.1 ${status} ${statusText(status)}\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    head += `${k}: ${v}\r\n`;
  }
  head += '\r\n';

  try {
    socket.write(head);
    socket.write(bodyBuf);
  } catch { /* socket closed */ }
}

function sendHttpResponseHeaders(
  socket: TLSSocket,
  status: number,
  headers: Record<string, string>,
): void {
  let head = `HTTP/1.1 ${status} ${statusText(status)}\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    head += `${k}: ${v}\r\n`;
  }
  head += '\r\n';
  try { socket.write(head); } catch { /* */ }
}

function writeChunked(socket: TLSSocket, chunk: Buffer | null): void {
  try {
    if (chunk === null) {
      socket.write('0\r\n\r\n');
    } else {
      socket.write(`${chunk.length.toString(16)}\r\n`);
      socket.write(chunk);
      socket.write('\r\n');
    }
  } catch { /* socket closed */ }
}

function statusText(code: number): string {
  const texts: Record<number, string> = {
    200: 'OK', 400: 'Bad Request', 401: 'Unauthorized',
    404: 'Not Found', 429: 'Too Many Requests', 502: 'Bad Gateway',
  };
  return texts[code] ?? 'Unknown';
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`[shutdown] received ${signal}, closing gracefully...`);
  flushHistory(getAllSessions());
  try { await fastify.close(); } catch { /* */ }
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => shutdown(sig));
}

// ── Web dashboard server (port 3000) ──────────────────────────────────────────

function startWebDashboard(): void {
  if (!DASHBOARD_HTML) {
    log('[dashboard] No dashboard HTML found — skipping web dashboard');
    return;
  }

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    // Serve stats by proxying to the Fastify server
    if (url === '/tokendiff/stats') {
      try {
        const statsRes = await fetch(`http://127.0.0.1:${PORT}/tokendiff/stats`);
        const data = await statsRes.text();
        res.writeHead(statsRes.status, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        });
        res.end(data);
      } catch {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy stats unavailable' }));
      }
      return;
    }

    // Serve dashboard HTML for root and /tokendiff paths
    if (url === '/' || url === '/tokendiff' || url === '/tokendiff/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(DASHBOARD_PORT, '0.0.0.0', () => {
    console.log(`  Dashboard:          http://localhost:${DASHBOARD_PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`[dashboard] Port ${DASHBOARD_PORT} in use — web dashboard not started`);
    } else {
      log(`[dashboard] Error: ${err.message}`);
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  const mitmCerts = loadMitmCerts();
  if (mitmCerts) {
    log('[connect] MITM certs loaded — CONNECT proxy will intercept & optimize TLS traffic');
  } else {
    log('[connect] No MITM certs — CONNECT proxy will tunnel through (no optimization on CONNECT)');
    log('[connect] HTTP forward proxy still optimizes all direct requests');
  }

  // Register CONNECT handler on the underlying Node HTTP server
  fastify.server.on('connect', (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    handleConnect(req, clientSocket, head, mitmCerts);
  });

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Trimr listening on 0.0.0.0:${PORT} [CONNECT proxy mode]`);
  console.log(`  HTTP forward proxy: set ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log(`  HTTPS CONNECT proxy: set HTTPS_PROXY=http://localhost:${PORT}`);

  startWebDashboard();

  loadHistory();
  setInterval(() => flushHistory(getAllSessions()), 30_000).unref();

  if (USE_DASHBOARD && NODE_ENV !== 'production') {
    startDashboard(PORT);
  }
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
