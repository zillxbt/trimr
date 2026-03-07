/**
 * Smoke test — fires real requests through the proxy and shows token savings.
 * Usage: npx tsx test/smoke.ts
 */
import { setTimeout as sleep } from 'timers/promises';

const PROXY = 'http://localhost:8787';
const API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
if (!API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

// ── Realistic payloads ────────────────────────────────────────────────────────

// Large system prompt (~1 500 tokens) — crosses Anthropic 1 024-token cache threshold
const SYSTEM_BASE = `You are an expert full-stack TypeScript engineer embedded in a large production monorepo.
The stack is: Node.js 22, Fastify 4, Prisma ORM, PostgreSQL 16, Redis 7, React 19, Vite 6, Tailwind CSS 4, Vitest.
TypeScript strict mode is enforced everywhere. All public APIs must be fully typed with JSDoc comments.

## Code conventions
- Prefer functional patterns; avoid classes unless the domain genuinely requires stateful objects
- Use a Result<T, E> discriminated union for error handling — never throw in business logic layers
- All async functions must handle errors explicitly; unhandled promise rejections fail the CI pipeline
- Database writes that touch more than one table MUST use Prisma transactions
- Never use "any"; use "unknown" with exhaustive type guards when the shape is truly unknown
- Imports are always named exports, never default (except React and third-party libs that force it)
- File names use kebab-case; exported types/interfaces use PascalCase; all functions use camelCase
- Every public function and exported type needs a JSDoc comment with at least a one-line description
- Tests use Vitest with describe/it blocks; every exported function needs at minimum one passing test
- All API route handlers must validate request bodies with Zod schemas before any business logic runs
- Prefer small focused functions (under 30 lines each); extract helpers rather than nesting logic
- Avoid magic numbers and strings — use named constants in a dedicated constants.ts file
- All environment variables must be accessed through a validated env.ts module using Zod .parse()

## Git and PR conventions
- Commits follow Conventional Commits: feat/fix/chore/refactor/test/docs
- Each PR should do exactly one thing; split unrelated changes into separate PRs
- PR descriptions must include a "Test plan" section with manual verification steps
- Breaking changes require a BREAKING CHANGE footer in the commit message

## Performance guidelines
- All database queries must include explicit select fields — never fetch entire rows unnecessarily
- Add database indexes for every foreign key and any column used in WHERE clauses
- Cache expensive computations in Redis with a TTL appropriate to data freshness requirements
- Paginate all list endpoints; default page size 20, maximum 100
- Use streaming for responses larger than 1 MB

## Security requirements
- Sanitize all user input before interpolating into SQL, shell commands, or log messages
- Never log passwords, tokens, PII, or raw request bodies containing sensitive fields
- All authenticated routes must verify both the JWT signature and the token type claim
- Rate-limit all public endpoints; authentication endpoints use stricter limits (10 req/min)
- CORS must be configured explicitly — never use wildcard origins in production

When asked to edit a file, return the COMPLETE updated file — never a partial snippet or diff.
When explaining changes, write one concise paragraph before showing the code.
Do not add redundant comments; the code should be self-documenting.
If a task is ambiguous, ask one clarifying question before proceeding.`;

// Extra section to push past the 1 024-token Anthropic cache threshold
const SYSTEM_EXTRA = `
## Observability and monitoring
- All HTTP handlers must emit structured JSON logs with: requestId, userId (if authed), route, statusCode, durationMs
- Use OpenTelemetry spans for any operation taking more than 50ms (DB queries, external HTTP, cache ops)
- Every error must be logged with a stack trace and a unique errorId for cross-referencing in alerts
- Expose a /health endpoint returning service status, uptime, and dependency connectivity checks
- SLO targets: p99 latency < 500ms for reads, < 1s for writes; error rate < 0.1% over any 5-minute window

## Dependency management
- Pin all direct dependencies to exact versions in package.json; use lockfile strictly
- Never install packages that duplicate functionality already provided by the existing stack
- Security-audit dependencies on every CI run; block merges on high-severity CVEs

## Testing standards
- Unit tests must not touch the database, filesystem, or network; use mocks and fakes
- Integration tests run against a real PostgreSQL instance spun up by Docker Compose in CI
- E2E tests use Playwright; cover the three most critical user journeys at minimum
- Test coverage must stay above 80% for all business logic modules; CI enforces this
- Snapshot tests are banned; prefer explicit assertions over serialised output comparisons
- Every bug fix must include a regression test that would have caught the original bug
- Tests must be deterministic; never rely on system time, random values, or insertion order without seeding
`;

const SYSTEM = SYSTEM_BASE + SYSTEM_EXTRA;

// Large file (~300 lines) — realistic API route file
const AUTH_FILE = `import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';

const prisma = new PrismaClient();
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-change-me');

// ── Schemas ───────────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const RefreshSchema = z.object({
  refreshToken: z.string(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(password + salt).digest('hex');
}

function generateSalt(): string {
  return randomBytes(32).toString('hex');
}

async function createAccessToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(JWT_SECRET);
}

async function createRefreshToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, type: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(JWT_SECRET);
}

async function verifyToken(token: string): Promise<{ sub: string; type: string } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return { sub: payload.sub as string, type: payload['type'] as string };
  } catch {
    return null;
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleRegister(
  req: FastifyRequest<{ Body: z.infer<typeof RegisterSchema> }>,
  reply: FastifyReply,
) {
  const { email, password, name } = RegisterSchema.parse(req.body);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return reply.status(409).send({ error: 'Email already registered' });
  }

  const salt = generateSalt();
  const passwordHash = hashPassword(password, salt);

  const user = await prisma.user.create({
    data: { email, name, passwordHash, salt },
    select: { id: true, email: true, name: true, createdAt: true },
  });

  const [accessToken, refreshToken] = await Promise.all([
    createAccessToken(user.id),
    createRefreshToken(user.id),
  ]);

  await prisma.refreshToken.create({
    data: { token: refreshToken, userId: user.id, expiresAt: new Date(Date.now() + 30 * 86400_000) },
  });

  return reply.status(201).send({ user, accessToken, refreshToken });
}

async function handleLogin(
  req: FastifyRequest<{ Body: z.infer<typeof LoginSchema> }>,
  reply: FastifyReply,
) {
  const { email, password } = LoginSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return reply.status(401).send({ error: 'Invalid credentials' });
  }

  const hash = hashPassword(password, user.salt);
  if (hash !== user.passwordHash) {
    return reply.status(401).send({ error: 'Invalid credentials' });
  }

  const [accessToken, refreshToken] = await Promise.all([
    createAccessToken(user.id),
    createRefreshToken(user.id),
  ]);

  await prisma.refreshToken.create({
    data: { token: refreshToken, userId: user.id, expiresAt: new Date(Date.now() + 30 * 86400_000) },
  });

  return reply.send({
    user: { id: user.id, email: user.email, name: user.name },
    accessToken,
    refreshToken,
  });
}

async function handleRefresh(
  req: FastifyRequest<{ Body: z.infer<typeof RefreshSchema> }>,
  reply: FastifyReply,
) {
  const { refreshToken } = RefreshSchema.parse(req.body);
  const payload = await verifyToken(refreshToken);

  if (!payload || payload.type !== 'refresh') {
    return reply.status(401).send({ error: 'Invalid refresh token' });
  }

  const stored = await prisma.refreshToken.findFirst({
    where: { token: refreshToken, userId: payload.sub, revoked: false },
  });

  if (!stored || stored.expiresAt < new Date()) {
    return reply.status(401).send({ error: 'Refresh token expired or revoked' });
  }

  // Rotate: revoke old, issue new
  const [newAccess, newRefresh] = await Promise.all([
    createAccessToken(payload.sub),
    createRefreshToken(payload.sub),
  ]);

  await prisma.$transaction([
    prisma.refreshToken.update({ where: { id: stored.id }, data: { revoked: true } }),
    prisma.refreshToken.create({
      data: { token: newRefresh, userId: payload.sub, expiresAt: new Date(Date.now() + 30 * 86400_000) },
    }),
  ]);

  return reply.send({ accessToken: newAccess, refreshToken: newRefresh });
}

async function handleLogout(
  req: FastifyRequest<{ Body: z.infer<typeof RefreshSchema> }>,
  reply: FastifyReply,
) {
  const { refreshToken } = RefreshSchema.parse(req.body);
  await prisma.refreshToken.updateMany({
    where: { token: refreshToken },
    data: { revoked: true },
  });
  return reply.status(204).send();
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', { schema: { body: RegisterSchema } }, handleRegister);
  app.post('/auth/login',    { schema: { body: LoginSchema } },    handleLogin);
  app.post('/auth/refresh',  { schema: { body: RefreshSchema } },  handleRefresh);
  app.post('/auth/logout',   { schema: { body: RefreshSchema } },  handleLogout);
}
`;

// Modified version — adds rate limiting (small change to large file)
const AUTH_FILE_V2 = AUTH_FILE.replace(
  '// ── Plugin ────────────────────────────────────────────────────────────────────',
  `// ── Rate limit config ─────────────────────────────────────────────────────────

const RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

// ── Plugin ────────────────────────────────────────────────────────────────────`,
).replace(
  "app.post('/auth/register', { schema: { body: RegisterSchema } }, handleRegister);",
  "app.post('/auth/register', { config: { rateLimit: RATE_LIMIT }, schema: { body: RegisterSchema } }, handleRegister);",
).replace(
  "app.post('/auth/login',    { schema: { body: LoginSchema } },    handleLogin);",
  "app.post('/auth/login',    { config: { rateLimit: RATE_LIMIT }, schema: { body: LoginSchema } }, handleLogin);",
);

// ── Helpers ───────────────────────────────────────────────────────────────────

type Message = { role: 'user' | 'assistant'; content: string };

async function call(messages: Message[], label: string, disableStages = ''): Promise<string> {
  process.stdout.write(`  ${label}... `);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': API_KEY,
  };
  if (disableStages) headers['x-tokendiff-disable'] = disableStages;

  const res = await fetch(`${PROXY}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      system: SYSTEM,
      messages,
    }),
  });
  const data = await res.json() as {
    content?: Array<{ type: string; text: string }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const input    = data.usage?.input_tokens ?? '?';
  const output   = data.usage?.output_tokens ?? '?';
  const cacheR   = data.usage?.cache_read_input_tokens;
  const cacheW   = data.usage?.cache_creation_input_tokens;
  const dedup    = res.headers.get('x-tokendiff-cache') === 'hit' ? ' [DEDUP]' : '';
  const cacheStr = cacheR ? ` [cache_read=${cacheR}]` : cacheW ? ` [cache_write=${cacheW}]` : '';
  console.log(`input=${input} out=${output}${cacheStr}${dedup}`);
  return data.content?.find(b => b.type === 'text')?.text ?? '';
}

async function getStats() {
  const res = await fetch(`${PROXY}/tokendiff/stats`);
  const data = await res.json() as { sessions: Array<{
    id: string; requestCount: number; tokensOriginal: number; tokensSaved: number;
    realInputTokens: number; cacheHits: number; diffsSent: number; dedupHits: number;
    summariesDone: number; outputTokens: number; cacheReadTokens: number;
  }> };
  return data.sessions;
}

function printStats(sessions: Awaited<ReturnType<typeof getStats>>, label: string) {
  let orig = 0, saved = 0, real = 0, cacheR = 0, ch = 0, df = 0, dd = 0, reqs = 0;
  for (const s of sessions) {
    orig += s.tokensOriginal; saved += s.tokensSaved; real += s.realInputTokens;
    cacheR += s.cacheReadTokens; ch += s.cacheHits; df += s.diffsSent;
    dd += s.dedupHits; reqs += s.requestCount;
  }
  const ratio = orig > 0 ? ((saved / orig) * 100).toFixed(1) : '0.0';
  const costOrig  = ((orig  / 1_000_000) * 0.80).toFixed(5);  // Haiku rate
  const costSaved = ((saved / 1_000_000) * 0.80).toFixed(5);
  console.log(`\n  ┌─ ${label} ${'─'.repeat(Math.max(0, 38 - label.length))}┐`);
  console.log(`  │  Requests       ${String(reqs).padStart(8)}                    │`);
  console.log(`  │  Est. original  ${String(orig).padStart(8)} tokens              │`);
  console.log(`  │  Actual billed  ${String(real || '?').padStart(8)} tokens              │`);
  console.log(`  │  Cache reads    ${String(cacheR).padStart(8)} tokens (10% rate)   │`);
  console.log(`  │  Tokens saved   ${String(saved).padStart(8)} tokens  (${ratio.padStart(5)}%)  │`);
  console.log(`  │  Cache hits     ${String(ch).padStart(8)}                    │`);
  console.log(`  │  File diffs     ${String(df).padStart(8)}                    │`);
  console.log(`  │  Dedup hits     ${String(dd).padStart(8)}                    │`);
  console.log(`  │  Cost (orig)    $${costOrig.padStart(9)}                   │`);
  console.log(`  │  Cost saved     $${costSaved.padStart(9)}                   │`);
  console.log(`  └${'─'.repeat(42)}┘\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     TokenDiff smoke test — realistic load    ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const s0 = await getStats();

  // ── Scenario 1: Repeated system prompt (cache) ───────────────────────────
  console.log('[ Scenario 1 ] System prompt caching — 5 calls, same large system prompt\n');
  for (let i = 1; i <= 5; i++) {
    await call([{ role: 'user', content: `What does the RefreshToken rotation pattern protect against? Answer in one sentence. (call ${i})` }], `call ${i}/5`, 'dedup');
    await sleep(400);
  }

  const s1 = await getStats();
  printStats(s1.map((s, i) => ({ ...s,
    tokensOriginal: s.tokensOriginal - (s0[i]?.tokensOriginal ?? 0),
    tokensSaved:    s.tokensSaved    - (s0[i]?.tokensSaved    ?? 0),
    realInputTokens:s.realInputTokens- (s0[i]?.realInputTokens?? 0),
    cacheReadTokens:s.cacheReadTokens- (s0[i]?.cacheReadTokens?? 0),
    requestCount:   s.requestCount   - (s0[i]?.requestCount   ?? 0),
    cacheHits:      s.cacheHits      - (s0[i]?.cacheHits      ?? 0),
    diffsSent:      s.diffsSent      - (s0[i]?.diffsSent      ?? 0),
    dedupHits:      s.dedupHits      - (s0[i]?.dedupHits      ?? 0),
  })), 'After scenario 1');

  // ── Scenario 2: Multi-turn with large file ───────────────────────────────
  console.log('[ Scenario 2 ] Multi-turn coding session — large file sent each turn\n');

  // Turn 1: send file, get response
  const turn1Reply = await call([
    { role: 'user', content: `Review this auth module and suggest one improvement:\n\`\`\`src/auth.ts\n${AUTH_FILE}\n\`\`\`` },
  ], 'turn 1 (full file)', 'dedup');
  await sleep(500);

  // Turn 2: same file again (should be omitted/diffed), history includes assistant echo
  const turn2Reply = await call([
    { role: 'user', content: `Review this auth module and suggest one improvement:\n\`\`\`src/auth.ts\n${AUTH_FILE}\n\`\`\`` },
    { role: 'assistant', content: turn1Reply },
    { role: 'user', content: `Now add rate limiting to the login and register endpoints:\n\`\`\`src/auth.ts\n${AUTH_FILE}\n\`\`\`` },
  ], 'turn 2 (same file, history)', 'dedup');
  await sleep(500);

  // Turn 3: modified file with growing history
  await call([
    { role: 'user', content: `Review this auth module and suggest one improvement:\n\`\`\`src/auth.ts\n${AUTH_FILE}\n\`\`\`` },
    { role: 'assistant', content: turn1Reply },
    { role: 'user', content: `Now add rate limiting to the login and register endpoints:\n\`\`\`src/auth.ts\n${AUTH_FILE}\n\`\`\`` },
    { role: 'assistant', content: turn2Reply },
    { role: 'user', content: `Here is the updated file with rate limiting added. Does it look correct?\n\`\`\`src/auth.ts\n${AUTH_FILE_V2}\n\`\`\`` },
  ], 'turn 3 (diff + history compression)', 'dedup');
  await sleep(500);

  const s2 = await getStats();
  const baseline1 = s1[0] ?? { tokensOriginal: 0, tokensSaved: 0, realInputTokens: 0, cacheReadTokens: 0, requestCount: 0, cacheHits: 0, diffsSent: 0, dedupHits: 0, summariesDone: 0, outputTokens: 0 };
  printStats(s2.map((s, i) => ({ ...s,
    tokensOriginal:  s.tokensOriginal  - (s1[i]?.tokensOriginal  ?? 0),
    tokensSaved:     s.tokensSaved     - (s1[i]?.tokensSaved     ?? 0),
    realInputTokens: s.realInputTokens - (s1[i]?.realInputTokens ?? 0),
    cacheReadTokens: s.cacheReadTokens - (s1[i]?.cacheReadTokens ?? 0),
    requestCount:    s.requestCount    - (s1[i]?.requestCount    ?? 0),
    cacheHits:       s.cacheHits       - (s1[i]?.cacheHits       ?? 0),
    diffsSent:       s.diffsSent       - (s1[i]?.diffsSent       ?? 0),
    dedupHits:       s.dedupHits       - (s1[i]?.dedupHits       ?? 0),
  })), 'After scenario 2');
  void baseline1;

  // ── Scenario 3: Dedup — identical requests ───────────────────────────────
  console.log('[ Scenario 3 ] Dedup — exact same request 4×\n');
  const dedupMsg: Message[] = [{ role: 'user', content: 'What hashing algorithm does this auth module use for passwords? One word.' }];
  for (let i = 1; i <= 4; i++) {
    await call(dedupMsg, `call ${i}/4`);
    await sleep(200);
  }

  const s3 = await getStats();
  printStats(s3.map((s, i) => ({ ...s,
    tokensOriginal:  s.tokensOriginal  - (s2[i]?.tokensOriginal  ?? 0),
    tokensSaved:     s.tokensSaved     - (s2[i]?.tokensSaved     ?? 0),
    realInputTokens: s.realInputTokens - (s2[i]?.realInputTokens ?? 0),
    cacheReadTokens: s.cacheReadTokens - (s2[i]?.cacheReadTokens ?? 0),
    requestCount:    s.requestCount    - (s2[i]?.requestCount    ?? 0),
    cacheHits:       s.cacheHits       - (s2[i]?.cacheHits       ?? 0),
    diffsSent:       s.diffsSent       - (s2[i]?.diffsSent       ?? 0),
    dedupHits:       s.dedupHits       - (s2[i]?.dedupHits       ?? 0),
  })), 'After scenario 3');

  // ── Grand total ──────────────────────────────────────────────────────────
  console.log('[ GRAND TOTAL ]\n');
  const final = await getStats();
  printStats(final.map((s, i) => ({ ...s,
    tokensOriginal:  s.tokensOriginal  - (s0[i]?.tokensOriginal  ?? 0),
    tokensSaved:     s.tokensSaved     - (s0[i]?.tokensSaved     ?? 0),
    realInputTokens: s.realInputTokens - (s0[i]?.realInputTokens ?? 0),
    cacheReadTokens: s.cacheReadTokens - (s0[i]?.cacheReadTokens ?? 0),
    requestCount:    s.requestCount    - (s0[i]?.requestCount    ?? 0),
    cacheHits:       s.cacheHits       - (s0[i]?.cacheHits       ?? 0),
    diffsSent:       s.diffsSent       - (s0[i]?.diffsSent       ?? 0),
    dedupHits:       s.dedupHits       - (s0[i]?.dedupHits       ?? 0),
  })), 'All scenarios combined');

  console.log('  Dashboard → http://localhost:8787/tokendiff/\n');
}

main().catch(console.error);
