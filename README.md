# Trimr

Transparent token-saving proxy for Anthropic and OpenAI APIs. Intercepts HTTPS API calls at the system level -- no configuration changes needed in Claude Code, Cursor, Codex, or any other tool.

## How it works

1. Generates a local CA certificate and installs it in your system trust store
2. Adds hosts file entries to redirect `api.anthropic.com` and `api.openai.com` to `127.0.0.1`
3. Runs a local HTTPS server that terminates TLS with domain-specific certificates
4. Applies the compression pipeline (caching, diffing, dedup, summarisation) to every request
5. Forwards the compressed request to the real API with the original API key intact

Your tools don't need any configuration changes. They make HTTPS calls to `api.anthropic.com` as usual, but the hosts file redirects them to Trimr first.

## Quick start

```bash
cd trimr
npm install

# Install (generates certs, modifies hosts, starts proxy)
# Requires administrator/sudo for hosts file and cert store
npx trimr install

# That's it. Claude Code, Cursor, Codex all work automatically.
```

## CLI commands

```
trimr install     Set up transparent proxy (certs, hosts, autostart)
trimr uninstall   Cleanly remove all system modifications
trimr start       Start the proxy service
trimr stop        Stop the proxy service
trimr status      Show proxy status and lifetime stats
trimr help        Show this help
```

## Uninstall

```bash
npx trimr uninstall
```

Cleanly reverses all changes:
- Stops the proxy
- Removes hosts file entries
- Removes CA from system trust store
- Removes autostart
- Removes certificate files

## Compression pipeline

| Step | What it does | Savings |
|---|---|---|
| **System prompt cache** | Hashes system prompt; on repeat calls adds Anthropic's native `cache_control` breakpoint | ~90% of system prompt on 2nd+ call |
| **File diffing** | Detects fenced code blocks, stores last version per file, sends only unified diffs | 60-90% on iterative edits |
| **History summarisation** | Once history > 8000 tokens, replaces old turns with a Haiku summary | 50-80% on long sessions |
| **Dedup** | Identical requests within 5 min return cached responses | 100% on duplicate calls |
| **Streaming passthrough** | SSE events forwarded byte-for-byte | no overhead |

## Proxy mode (non-intercept)

Trimr also works as a standard proxy without system modifications. Set `ANTHROPIC_BASE_URL` or your tool's base URL to `http://localhost:8787`:

```bash
# Start in standard proxy mode
npm run dev

# Point Claude Code at it
ANTHROPIC_BASE_URL=http://localhost:8787 claude
```

## Dashboard

In intercept mode, the dashboard runs at `http://localhost:3000`.
In proxy mode, the terminal dashboard starts automatically.

Stats are also available as JSON at `/tokendiff/stats`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | - | Fallback API key (optional -- tools pass their own) |
| `PORT` | `8787` | Proxy port (standard mode) |
| `DASHBOARD_PORT` | `3000` | Dashboard port (intercept mode) |
| `NODE_ENV` | `development` | Set to `production` for deployments |
| `TRIMR_MODE` | - | Set to `intercept` for transparent HTTPS interception |
| `TOKENDIFF_DASHBOARD` | `true` | Set `false` to disable terminal UI |

## Data directory

All Trimr data is stored in `~/.trimr/`:

```
~/.trimr/
  certs/           # CA and domain certificates
  trimr.pid        # PID of running proxy
  trimr.log        # Proxy log output
```

Historical stats are stored in `~/.tokendiff/history.json`.

## Deploy to Railway

Trimr also works as a hosted proxy on Railway. See `railway.toml` for config. In hosted mode, users pass their own API keys via `Authorization: Bearer <key>`.

## Architecture

```
[Claude Code / Cursor / Codex]
        |
        | HTTPS to api.anthropic.com (resolves to 127.0.0.1 via hosts file)
        v
  [Trimr HTTPS Server :443]
        |
        | Compression pipeline (cache, diff, dedup, summarise)
        |
        | HTTPS to real api.anthropic.com (resolved IP)
        v
  [Anthropic / OpenAI API]
```
