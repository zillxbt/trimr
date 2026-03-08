/**
 * Main install/uninstall orchestrator.
 *
 * Install flow (CONNECT proxy mode):
 *   1. Generate CA certificate + domain certs (for MITM on CONNECT tunnels)
 *   2. Install CA in system trust store
 *   3. Set HTTPS_PROXY and ANTHROPIC_BASE_URL env vars
 *   4. Set up autostart
 *   5. Start the proxy on port 8080
 *
 * Uninstall flow:
 *   1. Stop the proxy
 *   2. Remove env vars (HTTPS_PROXY, HTTP_PROXY, ANTHROPIC_BASE_URL)
 *   3. Remove CA from trust store
 *   4. Remove autostart
 *   5. Remove certificate files
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  generateCA,
  generateDomainCert,
  installCATrust,
  removeCATrust,
  clearAllCerts,
  verifyCertChain,
  getCertFingerprint,
  INTERCEPTED_DOMAINS,
} from './certificate.js';
import { startService, stopService, setupAutostart, removeAutostart, isRunning } from './service.js';

function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }

function ok(msg: string): void { console.log(`  ${green('+')} ${msg}`); }
function fail(msg: string): void { console.log(`  ${red('x')} ${msg}`); }
function warn(msg: string): void { console.log(`  ${yellow('!')} ${msg}`); }
function step(msg: string): void { console.log(`\n${bold(msg)}`); }

interface StepResult { success: boolean; message: string }

function report(result: StepResult): boolean {
  if (result.success) ok(result.message);
  else fail(result.message);
  return result.success;
}

const PROXY_PORT = 8080;
const PROXY_URL = `http://localhost:${PROXY_PORT}`;

// ── Install ───────────────────────────────────────────────────────────────────

export async function install(): Promise<boolean> {
  console.log(`\n${bold('Trimr Install')}`);
  console.log(dim('Setting up CONNECT tunnel proxy on port 8080\n'));

  let allOk = true;

  // Step 1 — Generate certificates (for MITM on CONNECT tunnels)
  step('1. Certificates (for CONNECT MITM)');
  try {
    clearAllCerts();
    const ca = generateCA();
    ok('CA certificate generated');
    ok(`CA fingerprint: ${getCertFingerprint(ca.cert)}`);

    const trustResult = installCATrust();
    if (!report(trustResult)) allOk = false;

    for (const domain of INTERCEPTED_DOMAINS) {
      generateDomainCert(domain, ca);
      ok(`Certificate for ${domain}`);
    }

    for (const domain of INTERCEPTED_DOMAINS) {
      const result = verifyCertChain(domain, ca);
      if (result.valid) {
        ok(result.message);
      } else {
        fail(result.message);
        allOk = false;
      }
    }
  } catch (e) {
    fail(`Certificate generation failed: ${(e as Error).message}`);
    warn('CONNECT MITM will be unavailable — HTTP forward proxy still works');
  }

  // Step 2 — Set proxy environment variables
  step('2. Proxy environment variables');
  try {
    if (process.platform === 'win32') {
      execSync(`setx HTTPS_PROXY "${PROXY_URL}"`, { stdio: 'pipe' });
      ok(`Set HTTPS_PROXY=${PROXY_URL}`);
      execSync(`setx HTTP_PROXY "${PROXY_URL}"`, { stdio: 'pipe' });
      ok(`Set HTTP_PROXY=${PROXY_URL}`);
      execSync(`setx ANTHROPIC_BASE_URL "${PROXY_URL}"`, { stdio: 'pipe' });
      ok(`Set ANTHROPIC_BASE_URL=${PROXY_URL}`);
    } else if (process.platform === 'darwin') {
      const profile = join(homedir(), '.zshrc');
      const lines = [
        `export HTTPS_PROXY="${PROXY_URL}" # trimr-proxy`,
        `export HTTP_PROXY="${PROXY_URL}" # trimr-proxy`,
        `export ANTHROPIC_BASE_URL="${PROXY_URL}" # trimr-proxy`,
      ];
      try {
        const content = readFileSync(profile, 'utf8');
        if (!content.includes('trimr-proxy')) {
          appendFileSync(profile, '\n' + lines.join('\n') + '\n');
        }
      } catch {
        appendFileSync(profile, '\n' + lines.join('\n') + '\n');
      }
      ok(`Added proxy env vars to ~/.zshrc`);
      warn('Run `source ~/.zshrc` or restart your terminal');
    } else {
      const profile = join(homedir(), '.bashrc');
      const lines = [
        `export HTTPS_PROXY="${PROXY_URL}" # trimr-proxy`,
        `export HTTP_PROXY="${PROXY_URL}" # trimr-proxy`,
        `export ANTHROPIC_BASE_URL="${PROXY_URL}" # trimr-proxy`,
      ];
      try {
        const content = readFileSync(profile, 'utf8');
        if (!content.includes('trimr-proxy')) {
          appendFileSync(profile, '\n' + lines.join('\n') + '\n');
        }
      } catch {
        appendFileSync(profile, '\n' + lines.join('\n') + '\n');
      }
      ok(`Added proxy env vars to ~/.bashrc`);
      warn('Run `source ~/.bashrc` or restart your terminal');
    }
    // Set for current process
    process.env.HTTPS_PROXY = PROXY_URL;
    process.env.HTTP_PROXY = PROXY_URL;
    process.env.ANTHROPIC_BASE_URL = PROXY_URL;
  } catch (e) {
    fail(`Failed to set proxy env vars: ${(e as Error).message}`);
    warn(`Manually set: HTTPS_PROXY=${PROXY_URL} ANTHROPIC_BASE_URL=${PROXY_URL}`);
    allOk = false;
  }

  // Step 3 — Autostart
  step('3. Autostart');
  const autoResult = setupAutostart();
  if (!report(autoResult)) {
    warn('Autostart setup failed — you can start Trimr manually with: trimr start');
  }

  // Step 4 — Start proxy
  step('4. Starting proxy');
  const startResult = startService({
    PORT: String(PROXY_PORT),
  });
  if (!report(startResult)) {
    allOk = false;
  }

  printSummary(allOk);
  return allOk;
}

function printSummary(allOk: boolean): void {
  console.log('');
  if (allOk) {
    console.log(green('  Install complete!'));
    console.log(dim('  Trimr CONNECT proxy running on port 8080.'));
    console.log(dim('  Claude Code will automatically route through Trimr.'));
    console.log(dim('  Dashboard: http://localhost:3000'));
    console.log(dim('  Restart your terminal/IDE for env vars to take effect.'));
    console.log(dim('  Run `trimr uninstall` to cleanly remove everything.'));
  } else {
    console.log(yellow('  Install completed with warnings. Check messages above.'));
  }
  console.log('');
}

// ── Uninstall ─────────────────────────────────────────────────────────────────

export function uninstall(): boolean {
  console.log(`\n${bold('Trimr Uninstall')}`);
  console.log(dim('Removing all Trimr system modifications\n'));

  let allOk = true;

  // Step 1 — Stop
  step('1. Stopping proxy');
  if (!report(stopService())) allOk = false;

  // Step 2 — Remove proxy env vars
  step('2. Proxy environment variables');
  try {
    if (process.platform === 'win32') {
      execSync('setx HTTPS_PROXY ""', { stdio: 'pipe' });
      execSync('setx HTTP_PROXY ""', { stdio: 'pipe' });
      execSync('setx ANTHROPIC_BASE_URL ""', { stdio: 'pipe' });
      ok('Removed HTTPS_PROXY, HTTP_PROXY, ANTHROPIC_BASE_URL');
    } else {
      for (const profile of [join(homedir(), '.zshrc'), join(homedir(), '.bashrc')]) {
        try {
          const content = readFileSync(profile, 'utf8');
          if (content.includes('trimr-proxy')) {
            const cleaned = content.split('\n').filter((l: string) => !l.includes('trimr-proxy')).join('\n');
            writeFileSync(profile, cleaned);
            ok(`Removed proxy env vars from ${profile}`);
          }
        } catch { /* file doesn't exist */ }
      }
    }
  } catch (e) {
    warn(`Could not remove proxy env vars: ${(e as Error).message}`);
  }

  // Step 3 — Trust store
  step('3. Certificate trust');
  if (!report(removeCATrust())) allOk = false;

  // Step 4 — Autostart
  step('4. Autostart');
  if (!report(removeAutostart())) allOk = false;

  // Step 5 — Cert files
  step('5. Certificate files');
  try {
    clearAllCerts();
    ok('All certificate files removed');
  } catch (e) {
    fail(`Failed to remove cert files: ${(e as Error).message}`);
    allOk = false;
  }

  console.log('');
  if (allOk) {
    console.log(green('  Uninstall complete! All Trimr modifications have been reversed.'));
  } else {
    console.log(yellow('  Uninstall completed with warnings. Check messages above.'));
  }
  console.log('');

  return allOk;
}
