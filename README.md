# Trimr

Token-saving proxy for Anthropic and OpenAI APIs. Cuts your API costs by caching, diffing, deduplicating, and summarising requests — transparent to Claude Code, Cursor, Codex, and any other tool.

## Install

```bash
npm install -g trimr
trimr install
```

Then open **http://localhost:3000** to see your savings.

That's it. Claude Code, Cursor, and Codex will automatically route through Trimr.

## How it works

Trimr runs as a CONNECT tunnel proxy on port 8080. It sets `HTTPS_PROXY` and `ANTHROPIC_BASE_URL` environment variables so your AI tools route through it automatically. Every API call is compressed before forwarding to the real API.

```
[Claude Code / Cursor / Codex]
        |
        | HTTPS via CONNECT proxy (localhost:8080)
        v
  [Trimr Proxy :8080]
        |
        | Compression pipeline (cache, diff, dedup, summarise)
        |
        | HTTPS to real API
        v
  [Anthropic / OpenAI API]
```

## Compression pipeline

| Step | What it does | Savings |
|---|---|---|
| **System prompt cache** | Hashes system prompt; on repeat calls adds Anthropic's native `cache_control` breakpoint | ~90% of system prompt on 2nd+ call |
| **File diffing** | Detects file contents in tool results and fenced code blocks, stores last version, sends only unified diffs | 60-90% on iterative edits |
| **History compression** | Strips echoed code from old assistant messages | 50-80% on long sessions |
| **Dedup** | Identical requests within 5 min return cached responses (full-request + last-turn hashing) | 100% on duplicate calls |
| **Streaming passthrough** | SSE events forwarded byte-for-byte | No overhead |

## CLI commands

```
trimr install     Set up proxy (env vars, autostart)
trimr uninstall   Cleanly remove all modifications
trimr start       Start the proxy service
trimr stop        Stop the proxy service
trimr status      Show proxy status and lifetime stats
trimr help        Show this help
```

## Uninstall

```bash
trimr uninstall
```

Cleanly reverses all changes — stops the proxy, removes env vars, removes autostart.

## Manual proxy mode

You can also point tools at Trimr manually without running `trimr install`:

```bash
# Start the proxy
trimr start

# Point Claude Code at it
ANTHROPIC_BASE_URL=http://localhost:8080 claude
```

## Dashboard

The web dashboard runs at **http://localhost:3000** showing live sessions, token savings, cost reduction, and compression ratios.

Stats are also available as JSON at `GET /tokendiff/stats`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Fallback API key (optional — tools pass their own) |
| `PORT` | `8080` | Proxy port |
| `DASHBOARD_PORT` | `3000` | Web dashboard port |
| `TOKENDIFF_DASHBOARD` | `true` | Set `false` to disable terminal UI |

## Data directory

```
~/.trimr/
  certs/           # Domain certificates (for MITM mode)
  trimr.pid        # PID of running proxy
  trimr.log        # Proxy log output
~/.tokendiff/
  history.json     # Lifetime statistics
```

## License

MIT
