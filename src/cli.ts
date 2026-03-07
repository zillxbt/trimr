#!/usr/bin/env node
/**
 * Trimr CLI
 *
 * Usage:
 *   trimr install   — set up transparent proxy (certs, hosts, autostart)
 *   trimr uninstall — cleanly remove everything
 *   trimr start     — start the proxy
 *   trimr stop      — stop the proxy
 *   trimr status    — show live stats
 *   trimr help      — show usage
 */
import { install, uninstall } from './install/installer.js';
import { startService, stopService, isRunning } from './install/service.js';
import { hasHostsEntries } from './install/hosts.js';
import { getAllSessions, getTotalTokensSaved } from './session.js';
import { getHistory } from './persistence.js';
import { getCACertPath, getCertDir } from './install/certificate.js';
import { getPidFile, getLogFile } from './install/paths.js';
import { existsSync, readFileSync } from 'fs';

function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }

const command = process.argv[2];

switch (command) {
  case 'install':
    install();
    break;

  case 'uninstall':
    uninstall();
    break;

  case 'start': {
    const result = startService();
    if (result.success) {
      console.log(green(`  + ${result.message}`));
    } else {
      console.log(red(`  x ${result.message}`));
      process.exit(1);
    }
    break;
  }

  case 'stop': {
    const result = stopService();
    if (result.success) {
      console.log(green(`  + ${result.message}`));
    } else {
      console.log(red(`  x ${result.message}`));
      process.exit(1);
    }
    break;
  }

  case 'status':
    showStatus();
    break;

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    showHelp();
    break;

  default:
    console.log(red(`Unknown command: ${command}`));
    showHelp();
    process.exit(1);
}

function showStatus(): void {
  console.log(`\n${bold('Trimr Status')}\n`);

  // Proxy status
  const running = isRunning();
  const statusIcon = running ? green('running') : red('stopped');
  console.log(`  Proxy:        ${statusIcon}`);

  // PID
  try {
    const pid = readFileSync(getPidFile(), 'utf8').trim();
    if (running) console.log(`  PID:          ${pid}`);
  } catch { /* no pid file */ }

  // Hosts
  const hosts = hasHostsEntries();
  console.log(`  Hosts file:   ${hosts ? green('configured') : yellow('not configured')}`);

  // Certificates
  const caExists = existsSync(getCACertPath());
  console.log(`  CA cert:      ${caExists ? green('installed') : yellow('not found')}`);
  if (caExists) console.log(`  Cert dir:     ${dim(getCertDir())}`);

  // Stats from persisted history
  try {
    const historyPath = require('path').join(require('os').homedir(), '.tokendiff', 'history.json');
    if (existsSync(historyPath)) {
      const history = JSON.parse(readFileSync(historyPath, 'utf8'));
      const lt = history.lifetime;
      if (lt) {
        console.log('');
        console.log(`  ${bold('Lifetime stats')}`);
        console.log(`  Requests:     ${lt.requestCount?.toLocaleString() ?? 0}`);
        console.log(`  Tokens in:    ${lt.tokensOriginal?.toLocaleString() ?? 0}`);
        console.log(`  Tokens saved: ${green(lt.tokensSaved?.toLocaleString() ?? '0')}`);
        if (lt.tokensOriginal > 0) {
          const pct = ((lt.tokensSaved / lt.tokensOriginal) * 100).toFixed(1);
          console.log(`  Compression:  ${green(pct + '%')}`);
        }
        console.log(`  Cache hits:   ${lt.cacheHits ?? 0}`);
        console.log(`  Diffs sent:   ${lt.diffsSent ?? 0}`);
        console.log(`  Dedup hits:   ${lt.dedupHits ?? 0}`);
      }
    }
  } catch { /* no history */ }

  // Log tail
  const logFile = getLogFile();
  if (existsSync(logFile)) {
    console.log(`\n  Log file:     ${dim(logFile)}`);
  }

  console.log('');
}

function showHelp(): void {
  console.log(`
${bold('Trimr')} — transparent token-saving proxy for AI APIs

${bold('Usage:')}
  trimr install     Set up transparent proxy (certs, hosts, autostart)
  trimr uninstall   Cleanly remove all system modifications
  trimr start       Start the proxy service
  trimr stop        Stop the proxy service
  trimr status      Show proxy status and lifetime stats
  trimr help        Show this help

${bold('How it works:')}
  Trimr intercepts HTTPS calls to api.anthropic.com and api.openai.com
  by installing a local CA certificate and modifying the hosts file.
  All API calls are compressed (system prompt caching, file diffs,
  dedup, summarisation) before forwarding to the real API.

  No configuration changes needed in Claude Code, Cursor, or Codex.

${dim('  Dashboard:  http://localhost:3000')}
${dim('  Data dir:   ~/.trimr/')}
`);
}
