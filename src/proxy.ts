import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { createServer as createHttpsServer } from 'https';
import { createServer as createHttpServer } from 'http';
import { createSecureContext } from 'tls';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
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

const PORT = parseInt(process.env.PORT ?? '8787', 10);
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? '3000', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const INTERCEPT_MODE = process.env.TRIMR_MODE === 'intercept';
const USE_DASHBOARD = process.env.TOKENDIFF_DASHBOARD !== 'false';

// Real upstream IPs — when in intercept mode, hosts file points domains to 127.0.0.1,
// so we need to resolve the real IPs ahead of time and talk to them directly.
const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
const OPENAI_UPSTREAM = 'https://api.openai.com';

const startTime = Date.now();

// ── Cert loading for intercept mode ───────────────────────────────────────────

function loadInterceptCerts(): Map<string, { key: string; cert: string }> | null {
  if (!INTERCEPT_MODE) return null;

  const certDir = join(homedir(), '.trimr', 'certs');
  const domains = ['api.anthropic.com', 'api.openai.com'];
  const certs = new Map<string, { key: string; cert: string }>();

  for (const domain of domains) {
    const keyPath = join(certDir, `${domain}.key`);
    const certPath = join(certDir, `${domain}.pem`);
    if (!existsSync(keyPath) || !existsSync(certPath)) {
      console.error(`[intercept] Missing cert for ${domain}. Run: trimr install`);
      return null;
    }
    certs.set(domain, {
      key: readFileSync(keyPath, 'utf8'),
      cert: readFileSync(certPath, 'utf8'),
    });
  }

  return certs;
}

// ── DNS resolution for intercept mode ─────────────────────────────────────────
// When hosts file redirects api.anthropic.com to 127.0.0.1, we can't use the
// domain name to reach the real API. We resolve real IPs at startup.

import { resolve as dnsResolve } from 'dns';
import { promisify } from 'util';
const dnsResolveAsync = promisify(dnsResolve);

const realIPs: Record<string, string> = {};

async function resolveUpstreamIPs(): Promise<void> {
  if (!INTERCEPT_MODE) return;

  // Before hosts are modified, or use a known fallback
  // These are well-known Anthropic/OpenAI IPs but we should resolve them
  // before the hosts file is modified. In practice the installer resolves
  // them before modifying hosts. We store them and use IP-based URLs.
  for (const domain of ['api.anthropic.com', 'api.openai.com']) {
    try {
      const ips = await dnsResolveAsync(domain);
      if (ips.length > 0) realIPs[domain] = ips[0];
    } catch {
      // If DNS fails (hosts already modified), we'll use the domain with
      // a custom fetch agent that bypasses the hosts file.
      log(`[intercept] Could not resolve ${domain} — will use direct connection`);
    }
  }
}

/** Build the upstream URL, bypassing the hosts file redirect */
function getUpstreamUrl(domain: string, path: string): string {
  if (!INTERCEPT_MODE) {
    // Standard mode — just use the domain directly
    return domain === 'api.anthropic.com'
      ? `${ANTHROPIC_UPSTREAM}${path}`
      : `${OPENAI_UPSTREAM}${path}`;
  }

  // In intercept mode, if we have a resolved IP, use it
  const ip = realIPs[domain];
  if (ip) {
    return `https://${ip}${path}`;
  }
  // Fallback — use domain (works if hosts were just modified and DNS cache has the old entry)
  return domain === 'api.anthropic.com'
    ? `${ANTHROPIC_UPSTREAM}${path}`
    : `${OPENAI_UPSTREAM}${path}`;
}

/** Build fetch options that include the Host header for IP-based requests */
function upstreamFetchOpts(domain: string, headers: Record<string, string>, body: string): RequestInit {
  const opts: RequestInit = {
    method: 'POST',
    headers: { ...headers, 'host': domain },
    body,
  };
  return opts;
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
    mode: INTERCEPT_MODE ? 'intercept' : 'proxy',
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
  return reply.send({ name: 'trimr', mode: INTERCEPT_MODE ? 'intercept' : 'proxy' });
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

// ── Anthropic /v1/messages proxy ──────────────────────────────────────────────

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

  const result = await runPipeline(body, apiKey, sessionId, disabled);
  body = result.body;
  const { session, originalReq } = result;

  // Dedup hits
  if (result.dedupStreamHit) {
    reply.raw.statusCode = 200;
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('x-trimr-cache', 'hit');
    reply.raw.write(result.dedupStreamHit);
    reply.raw.end();
    return reply;
  }
  if (result.dedupJsonHit) {
    return reply.header('x-trimr-cache', 'hit').send(result.dedupJsonHit);
  }

  // Build upstream headers
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

  const upstreamUrl = getUpstreamUrl('api.anthropic.com', '/v1/messages');

  let anthropicRes: Response;
  try {
    anthropicRes = await fetchWithRetry(upstreamUrl, {
      method: 'POST',
      headers: { ...upstreamHeaders, host: 'api.anthropic.com' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    log(`[upstream] fetch error: ${(e as Error).message}`);
    return reply.status(502).send({ type: 'error', error: { message: 'Upstream unreachable' } });
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

    if (data.usage) {
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

// Handle both /v1/chat/completions (intercept mode) and /openai/v1/chat/completions (proxy mode)
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

    // Rebuild OpenAI messages from processed body
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
    const upstreamUrl = getUpstreamUrl('api.openai.com', '/v1/chat/completions');

    let openaiRes: Response;
    try {
      openaiRes = await fetchWithRetry(upstreamUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
          'host': 'api.openai.com',
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
  const upstreamUrl = getUpstreamUrl('api.anthropic.com', req.url);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey ?? '',
    'anthropic-version': (req.headers['anthropic-version'] as string | undefined) ?? '2023-06-01',
    'host': 'api.anthropic.com',
  };

  const rawBody = req.body != null
    ? typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    : undefined;

  const res = await fetch(upstreamUrl, { method: req.method, headers, body: rawBody });
  const data = await res.json();
  return reply.status(res.status).send(data);
});

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

// ── Start ─────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Resolve upstream IPs before starting (for intercept mode)
  await resolveUpstreamIPs();

  if (INTERCEPT_MODE) {
    // ── Intercept mode: HTTPS server on port 443 with SNI ──────────────
    const interceptCerts = loadInterceptCerts();
    if (!interceptCerts) {
      console.error('Cannot start in intercept mode without certificates. Run: trimr install');
      process.exit(1);
    }

    // Use the first domain's cert as default, SNI callback picks the right one
    const defaultCert = interceptCerts.values().next().value!;

    const httpsServer = createHttpsServer(
      {
        key: defaultCert.key,
        cert: defaultCert.cert,
        SNICallback: (servername, cb) => {
          const domainCert = interceptCerts.get(servername);
          if (domainCert) {
            const ctx = createSecureContext({
              key: domainCert.key,
              cert: domainCert.cert,
            });
            cb(null, ctx);
          } else {
            cb(null, undefined);
          }
        },
      },
    );

    // Route the HTTPS server through Fastify
    await fastify.listen({ port: 443, host: '0.0.0.0' }, (err) => {
      if (err) {
        // Port 443 may need elevation
        console.error(`Cannot bind to port 443: ${err.message}`);
        console.error('Run with administrator/sudo privileges, or use: trimr install');
        process.exit(1);
      }
    });

    // Wrap: Fastify uses its own server, but we need HTTPS. Use serverFactory.
    // Actually, Fastify supports https natively. Let's restart with https opts.
    await fastify.close();

    const fastifyHttps = Fastify({
      logger: false,
      trustProxy: true,
      https: {
        key: defaultCert.key,
        cert: defaultCert.cert,
        SNICallback: (servername: string, cb: (err: Error | null, ctx?: any) => void) => {
          const domainCert = interceptCerts.get(servername);
          if (domainCert) {
            cb(null, createSecureContext({
              key: domainCert.key,
              cert: domainCert.cert,
            }));
          } else {
            cb(null, undefined);
          }
        },
      },
    });

    // Register routes (including content type parser) on the HTTPS instance
    registerRoutesOn(fastifyHttps);

    await fastifyHttps.listen({ port: 443, host: '0.0.0.0' });
    console.log(`Server listening on 0.0.0.0:443 [intercept mode]`);

    // Also start dashboard HTTP server on port 3000
    startDashboardServer();
  } else {
    // ── Standard proxy mode ────────────────────────────────────────────
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server listening on 0.0.0.0:${PORT}`);
  }

  loadHistory();
  setInterval(() => flushHistory(getAllSessions()), 30_000).unref();

  if (!INTERCEPT_MODE && USE_DASHBOARD && NODE_ENV !== 'production') {
    startDashboard(PORT);
  } else if (!INTERCEPT_MODE) {
    console.log(`Trimr proxy running [${NODE_ENV}]`);
  }
}

/** Register all API routes on a Fastify instance (used for HTTPS intercept server) */
function registerRoutesOn(app: ReturnType<typeof Fastify>): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req: any, body: any, done: any) => {
      try { done(null, JSON.parse(body as string)); }
      catch (e) { done(e as Error, undefined); }
    },
  );
  // Health
  app.get('/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    totalTokensSaved: getTotalTokensSaved() + (getHistory().lifetime?.tokensSaved ?? 0),
    activeSessions: getAllSessions().length,
    mode: 'intercept',
  }));

  // Anthropic messages
  app.post('/v1/messages', async (req: FastifyRequest, reply: FastifyReply) => {
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
    const result = await runPipeline(body, apiKey, sessionId, disabled);
    body = result.body;
    const { session, originalReq } = result;

    if (result.dedupStreamHit) {
      reply.raw.statusCode = 200;
      reply.raw.setHeader('content-type', 'text/event-stream');
      reply.raw.setHeader('x-trimr-cache', 'hit');
      reply.raw.write(result.dedupStreamHit);
      reply.raw.end();
      return reply;
    }
    if (result.dedupJsonHit) {
      return reply.header('x-trimr-cache', 'hit').send(result.dedupJsonHit);
    }

    const upstreamHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': (req.headers['anthropic-version'] as string | undefined) ?? '2023-06-01',
      'host': 'api.anthropic.com',
    };

    const hasCacheCtl = Array.isArray(body.system) &&
      body.system.some((b: { cache_control?: unknown }) => b.cache_control);
    const beta = req.headers['anthropic-beta'] as string | undefined;
    if (hasCacheCtl) {
      const bv = new Set<string>(['prompt-caching-2024-07-31']);
      if (beta) beta.split(',').map(s => s.trim()).forEach(v => bv.add(v));
      upstreamHeaders['anthropic-beta'] = [...bv].join(',');
    } else if (beta) {
      upstreamHeaders['anthropic-beta'] = beta;
    }

    const url = getUpstreamUrl('api.anthropic.com', '/v1/messages');
    let res: Response;
    try {
      res = await fetchWithRetry(url, { method: 'POST', headers: upstreamHeaders, body: JSON.stringify(body) });
    } catch (e) {
      return reply.status(502).send({ type: 'error', error: { message: 'Upstream unreachable' } });
    }

    if (body.stream) {
      reply.raw.statusCode = res.status;
      reply.raw.setHeader('content-type', 'text/event-stream');
      for (const [k, v] of res.headers.entries()) {
        if (k.startsWith('x-')) reply.raw.setHeader(k, v);
      }
      if (res.body) {
        const reader = res.body.getReader();
        const cache = !disabled.has('dedup') && res.status === 200;
        const chunks: Buffer[] = [];
        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = Buffer.from(value);
              if (cache) chunks.push(chunk);
              reply.raw.write(chunk);
            }
            if (cache && chunks.length > 0) storeStreamDedup(originalReq, Buffer.concat(chunks));
          } catch { /* */ } finally { reply.raw.end(); }
        })();
      } else { reply.raw.end(); }
      return reply;
    }

    const data = await res.json() as any;
    if (data.usage) {
      session.stats.realInputTokens += data.usage.input_tokens ?? 0;
      session.stats.outputTokens += data.usage.output_tokens ?? 0;
      session.stats.cacheReadTokens += data.usage.cache_read_input_tokens ?? 0;
      session.stats.tokensSaved = Math.max(0, session.stats.tokensOriginal - session.stats.realInputTokens);
    }
    if (!disabled.has('dedup') && res.status === 200) storeDedup(originalReq, data);
    return reply.status(res.status).send(data);
  });

  // OpenAI chat completions
  app.post('/v1/chat/completions', async (req: FastifyRequest, reply: FastifyReply) => {
    const apiKey = resolveApiKey(req);
    if (!apiKey) {
      return reply.status(401).send({ error: { message: 'No API key', type: 'authentication_error' } });
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

    const url = getUpstreamUrl('api.openai.com', '/v1/chat/completions');
    let res: Response;
    try {
      res = await fetchWithRetry(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
          'host': 'api.openai.com',
        },
        body: JSON.stringify({ ...oaiBody, messages: processedMessages }),
      });
    } catch (e) {
      return reply.status(502).send({ error: { message: 'OpenAI upstream unreachable' } });
    }

    if (oaiBody.stream) {
      reply.raw.statusCode = res.status;
      reply.raw.setHeader('content-type', 'text/event-stream');
      if (res.body) {
        const reader = res.body.getReader();
        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              reply.raw.write(Buffer.from(value));
            }
          } catch { /* */ } finally { reply.raw.end(); }
        })();
      } else { reply.raw.end(); }
      return reply;
    }
    const data = await res.json();
    return reply.status(res.status).send(data);
  });

  // Catch-all passthrough for other /v1/* routes
  app.all('/v1/*', { config: {} }, async (req: FastifyRequest, reply: FastifyReply) => {
    const apiKey = resolveApiKey(req);
    const url = getUpstreamUrl('api.anthropic.com', req.url);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': apiKey ?? '',
      'anthropic-version': (req.headers['anthropic-version'] as string | undefined) ?? '2023-06-01',
      'host': 'api.anthropic.com',
    };
    const rawBody = req.body != null
      ? typeof req.body === 'string' ? req.body : JSON.stringify(req.body) : undefined;
    const res = await fetch(url, { method: req.method, headers, body: rawBody });
    const data = await res.json();
    return reply.status(res.status).send(data);
  });
}

/** Start a separate HTTP dashboard server on port 3000 */
function startDashboardServer(): void {
  const dashApp = Fastify({ logger: false });

  dashApp.get('/', async (_req, reply) => {
    return reply.header('content-type', 'text/html; charset=utf-8').send(DASHBOARD_HTML);
  });

  dashApp.get('/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    totalTokensSaved: getTotalTokensSaved() + (getHistory().lifetime?.tokensSaved ?? 0),
    activeSessions: getAllSessions().length,
    mode: 'intercept',
  }));

  dashApp.get('/tokendiff/stats', async () => ({
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
  }));

  dashApp.listen({ port: DASHBOARD_PORT, host: '0.0.0.0' }).then(() => {
    console.log(`Dashboard listening on 0.0.0.0:${DASHBOARD_PORT}`);
  }).catch((e) => {
    console.error(`Dashboard failed to start on port ${DASHBOARD_PORT}: ${e.message}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
