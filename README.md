# Trimr (TokenDiff)

Proxy that sits between your AI tools and the Anthropic/OpenAI APIs, reducing token usage through intelligent caching, diffing, and conversation summarisation.

Works locally or deployed to Railway (or any container host) as a shared proxy.

## Install (local)

```bash
cd tokendiff
npm install
npm run dev
```

> Requires Node.js 18+.

## Hosted usage (Railway)

If Trimr is deployed at e.g. `https://trimr-production.up.railway.app`, point your tools at it instead of localhost.

### Cursor

Settings > Models > OpenAI Base URL:

```
https://trimr-production.up.railway.app/v1
```

Pass your Anthropic API key as the API key in Cursor's settings — Trimr forwards it upstream.

### Windsurf

In `~/.codeium/windsurf/config.json`:

```json
{
  "anthropicBaseUrl": "https://trimr-production.up.railway.app"
}
```

### Claude Code

```bash
ANTHROPIC_BASE_URL=https://trimr-production.up.railway.app claude
```

### Custom app / SDK

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'https://trimr-production.up.railway.app',
  apiKey: 'sk-ant-...',  // your key — forwarded upstream
});
```

Or use `Authorization: Bearer <your-api-key>` header with any HTTP client.

## Authentication

Trimr uses bearer token auth. Include your own API key in requests — Trimr forwards it to the upstream provider on your behalf. Session state is tied to a hash of your API key, so each user gets isolated sessions automatically.

Supported auth methods (in priority order):
1. `Authorization: Bearer <key>` header
2. `x-api-key: <key>` header
3. `ANTHROPIC_API_KEY` env var (fallback for single-user local setups)

## OpenAI-compatible proxy

Trimr also proxies OpenAI API requests at `/openai/v1/chat/completions`. The same compression pipeline (diffing, dedup, summarisation) is applied before forwarding to `api.openai.com`.

```bash
curl https://trimr-production.up.railway.app/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'
```

Point any OpenAI-compatible client at `https://trimr-production.up.railway.app/openai` as the base URL.

## Compression pipeline

| Step | What it does | Savings |
|---|---|---|
| **System prompt cache** | Hashes system prompt; on repeat calls adds Anthropic's native `cache_control` breakpoint so the prompt costs 10% | ~90% of system prompt on 2nd+ call |
| **File diffing** | Detects fenced code blocks, stores last version per file, sends only unified diffs | 60-90% on iterative edits |
| **History summarisation** | Once history > 8 000 tokens, replaces old turns with a Haiku summary | 50-80% on long sessions |
| **Dedup** | Identical requests within 5 min return cached responses | 100% on duplicate calls |
| **Streaming passthrough** | SSE events forwarded byte-for-byte | no overhead |

## Example token savings

| Scenario | Tokens without proxy | Tokens with proxy | Saving |
|---|---|---|---|
| 10 calls, same 2 000-token system prompt | 20 000 | 2 000 + 9 x 200 = 3 800 | **81%** |
| 5 rounds of 500-line file edits | 12 500 | ~2 500 (diffs only) | **80%** |
| 20-turn chat, 10 000 token history | 20 000 | ~5 000 (summary + 4 turns) | **75%** |

## Health check

```bash
curl https://trimr-production.up.railway.app/health
```

Returns:
```json
{
  "status": "ok",
  "uptime": 3600,
  "totalTokensSaved": 150000,
  "activeSessions": 3,
  "environment": "production"
}
```

## Dashboard

The terminal dashboard starts automatically in development. Disabled in production (`NODE_ENV=production`).

```bash
TOKENDIFF_DASHBOARD=false npm run dev   # disable manually
```

Stats are also available as JSON at `/tokendiff/stats`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | - | Fallback API key (optional — users pass their own via bearer token) |
| `PORT` | `8787` | Server port |
| `NODE_ENV` | `development` | Set to `production` for Railway deployments |
| `TOKENDIFF_DASHBOARD` | `true` | Set `false` to disable blessed TUI |

## Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

1. Fork this repo
2. Create a new Railway project from the repo
3. Set `PORT` env var (Railway provides this automatically)
4. Optionally set `ANTHROPIC_API_KEY` as a default fallback
5. Deploy — the `/health` endpoint is used for health checks

## Optional session header

To get per-project stats (instead of per-API-key grouping), pass:

```
x-tokendiff-session: my-project-name
```
