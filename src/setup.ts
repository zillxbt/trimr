/**
 * tokendiff setup — configures AI coding tools to route through the proxy.
 * Run via: npx tokendiff setup
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

const PORT = parseInt(process.env.PORT ?? '8787', 10);
const PROXY_URL = `http://localhost:${PORT}`;
const MARKER = '# tokendiff';

const isWindows = process.platform === 'win32';

// ── Helpers ───────────────────────────────────────────────────────────────────

function green(s: string)  { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string) { return `\x1b[33m${s}\x1b[0m`; }
function bold(s: string)   { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string)    { return `\x1b[2m${s}\x1b[0m`; }

function ok(msg: string)   { console.log(`  ${green('✓')} ${msg}`); }
function warn(msg: string) { console.log(`  ${yellow('!')} ${msg}`); }
function info(msg: string) { console.log(`  ${dim('·')} ${msg}`); }

function isInPath(cmd: string): boolean {
  try { execSync(`${isWindows ? 'where' : 'which'} ${cmd}`, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function alreadySet(filePath: string, value: string): boolean {
  try { return readFileSync(filePath, 'utf8').includes(value); }
  catch { return false; }
}

// ── Shell profile setup ───────────────────────────────────────────────────────

function detectShellProfile(): string | null {
  if (isWindows) return null; // handled separately
  const shell = process.env.SHELL ?? '';
  const candidates = [
    shell.includes('zsh')  && join(homedir(), '.zshrc'),
    shell.includes('bash') && join(homedir(), '.bashrc'),
    join(homedir(), '.profile'),
  ].filter(Boolean) as string[];
  return candidates.find(existsSync) ?? candidates[0] ?? null;
}

function setupShellProfile(): void {
  const profile = detectShellProfile();
  if (!profile) return;
  const line = `\nexport ANTHROPIC_BASE_URL="${PROXY_URL}"  ${MARKER}\n`;
  if (alreadySet(profile, MARKER)) {
    ok(`Shell profile already configured (${profile})`);
    return;
  }
  appendFileSync(profile, line);
  ok(`Added ANTHROPIC_BASE_URL to ${profile}`);
  info(`Restart your terminal or run: source ${profile}`);
}

function setupPowerShell(): void {
  const profileDir  = join(homedir(), 'Documents', 'WindowsPowerShell');
  const profilePath = join(profileDir, 'Microsoft.PowerShell_profile.ps1');
  const line = `\n$env:ANTHROPIC_BASE_URL = "${PROXY_URL}"  ${MARKER}\n`;

  try { mkdirSync(profileDir, { recursive: true }); } catch {}

  if (alreadySet(profilePath, MARKER)) {
    ok(`PowerShell profile already configured`);
    return;
  }
  appendFileSync(profilePath, line);
  ok(`Added ANTHROPIC_BASE_URL to PowerShell profile`);
  info(`Restart PowerShell or run: . $PROFILE`);
}

// ── Claude Code ───────────────────────────────────────────────────────────────

function setupClaudeCode(): void {
  console.log(`\n${bold('Claude Code')}`);

  if (!isInPath('claude')) {
    warn('claude not found in PATH — install from https://claude.ai/code');
    return;
  }
  ok('claude detected in PATH');

  // Write a wrapper script so `claude` automatically uses the proxy
  const binDir = join(homedir(), '.local', 'bin');
  const wrapperPath = isWindows
    ? join(homedir(), 'AppData', 'Local', 'tokendiff', 'claude.ps1')
    : join(binDir, 'claude-proxied');

  if (isWindows) {
    try { mkdirSync(join(homedir(), 'AppData', 'Local', 'tokendiff'), { recursive: true }); } catch {}
    const script =
      `# TokenDiff wrapper for Claude Code\n` +
      `$env:ANTHROPIC_BASE_URL = "${PROXY_URL}"\n` +
      `claude @args\n`;
    writeFileSync(wrapperPath, script);
    ok(`Created wrapper: ${wrapperPath}`);
    info(`Run Claude Code via proxy with: .\\${wrapperPath}`);
    info(`Or set permanently: add to your PowerShell profile (see above)`);
  } else {
    try { mkdirSync(binDir, { recursive: true }); } catch {}
    const script =
      `#!/usr/bin/env bash\n` +
      `# TokenDiff wrapper for Claude Code\n` +
      `ANTHROPIC_BASE_URL="${PROXY_URL}" claude "$@"\n`;
    writeFileSync(wrapperPath, script);
    execSync(`chmod +x ${wrapperPath}`);
    ok(`Created wrapper: ${wrapperPath}`);
    info(`Use 'claude-proxied' instead of 'claude' to route through TokenDiff`);
  }
}

// ── Cursor ────────────────────────────────────────────────────────────────────

function setupCursor(): void {
  console.log(`\n${bold('Cursor')}`);

  const configPath = isWindows
    ? join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'settings.json')
    : join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json');

  if (!existsSync(configPath)) {
    warn('Cursor settings not found — is Cursor installed?');
    info('Manual setup: Settings → Models → anthropicBaseUrl → ' + PROXY_URL);
    return;
  }

  try {
    const raw = readFileSync(configPath, 'utf8');
    const settings = JSON.parse(raw);

    if (settings['anthropic.baseUrl'] === PROXY_URL) {
      ok('Cursor already configured');
      return;
    }

    settings['anthropic.baseUrl'] = PROXY_URL;
    writeFileSync(configPath, JSON.stringify(settings, null, 2));
    ok(`Updated Cursor settings: anthropic.baseUrl = ${PROXY_URL}`);
  } catch {
    warn(`Could not update Cursor settings at ${configPath}`);
    info('Manual setup: Settings → Models → anthropicBaseUrl → ' + PROXY_URL);
  }
}

// ── Custom app ────────────────────────────────────────────────────────────────

function printCustomInstructions(): void {
  console.log(`\n${bold('Custom app / SDK')}`);
  info(`Set env var:  ANTHROPIC_BASE_URL=${PROXY_URL}`);
  info(`Or in SDK:    new Anthropic({ baseURL: "${PROXY_URL}" })`);
  info(`Session tag:  x-tokendiff-session: my-project-name`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n${bold('TokenDiff Setup')}`);
console.log(dim(`Configuring tools to proxy through ${PROXY_URL}\n`));

// Shell profile (Unix) / PowerShell (Windows)
console.log(`\n${bold('Shell environment')}`);
if (isWindows) {
  setupPowerShell();
} else {
  setupShellProfile();
}

setupClaudeCode();
setupCursor();
printCustomInstructions();

console.log(`\n${green('Done!')} Start the proxy with: ${bold('npx tokendiff')}`);
console.log(dim(`Dashboard: ${PROXY_URL}/tokendiff/\n`));
