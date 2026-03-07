/**
 * Main install/uninstall orchestrator.
 *
 * Install flow:
 *   1. Generate CA certificate
 *   2. Install CA in system trust store
 *   3. Generate domain certificates for intercepted APIs
 *   4. Add hosts file entries (api.anthropic.com → 127.0.0.1)
 *   5. Set up autostart
 *   6. Start the proxy
 *
 * Uninstall flow:
 *   1. Stop the proxy
 *   2. Remove hosts entries
 *   3. Remove CA from trust store
 *   4. Remove autostart
 *   5. Remove certificate files
 */
import {
  getOrCreateCA,
  getOrCreateDomainCert,
  installCATrust,
  removeCATrust,
  removeCertFiles,
  INTERCEPTED_DOMAINS,
} from './certificate.js';
import { addHostsEntries, removeHostsEntries } from './hosts.js';
import { startService, stopService, setupAutostart, removeAutostart } from './service.js';

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

// ── Install ───────────────────────────────────────────────────────────────────

export function install(): boolean {
  console.log(`\n${bold('Trimr Install')}`);
  console.log(dim('Setting up transparent HTTPS intercept proxy\n'));

  let allOk = true;

  // Step 1 — CA
  step('1. Certificate Authority');
  try {
    const ca = getOrCreateCA();
    ok('CA certificate generated');

    // Step 2 — Trust
    const trustResult = installCATrust();
    if (!report(trustResult)) allOk = false;

    // Step 3 — Domain certs
    step('2. Domain certificates');
    for (const domain of INTERCEPTED_DOMAINS) {
      getOrCreateDomainCert(domain, ca);
      ok(`Certificate for ${domain}`);
    }
  } catch (e) {
    fail(`Certificate generation failed: ${(e as Error).message}`);
    allOk = false;
  }

  // Step 4 — Hosts
  step('3. Hosts file');
  if (!report(addHostsEntries())) allOk = false;

  // Step 5 — Autostart
  step('4. Autostart');
  const autoResult = setupAutostart();
  if (!report(autoResult)) {
    warn('Autostart setup failed — you can start Trimr manually with: trimr start');
  }

  // Step 6 — Start
  step('5. Starting proxy');
  const startResult = startService();
  if (!report(startResult)) allOk = false;

  // Summary
  console.log('');
  if (allOk) {
    console.log(green('  Install complete!'));
    console.log(dim('  Trimr is now intercepting API calls transparently.'));
    console.log(dim('  Dashboard: http://localhost:3000'));
    console.log(dim('  Run `trimr status` to check savings.'));
    console.log(dim('  Run `trimr uninstall` to cleanly remove everything.'));
  } else {
    console.log(yellow('  Install completed with warnings. Check messages above.'));
  }
  console.log('');

  return allOk;
}

// ── Uninstall ─────────────────────────────────────────────────────────────────

export function uninstall(): boolean {
  console.log(`\n${bold('Trimr Uninstall')}`);
  console.log(dim('Removing all Trimr system modifications\n'));

  let allOk = true;

  // Step 1 — Stop
  step('1. Stopping proxy');
  if (!report(stopService())) allOk = false;

  // Step 2 — Hosts
  step('2. Hosts file');
  if (!report(removeHostsEntries())) allOk = false;

  // Step 3 — Trust store
  step('3. Certificate trust');
  if (!report(removeCATrust())) allOk = false;

  // Step 4 — Autostart
  step('4. Autostart');
  if (!report(removeAutostart())) allOk = false;

  // Step 5 — Cert files
  step('5. Certificate files');
  try {
    removeCertFiles();
    ok('Certificate files removed');
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
