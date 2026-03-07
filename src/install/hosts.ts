/**
 * Hosts file modification — redirects API domains to 127.0.0.1.
 *
 * On Windows, writes a temp PowerShell script and runs it elevated.
 * On macOS/Linux, uses sudo.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { INTERCEPTED_DOMAINS } from './certificate.js';

const MARKER = '# trimr-proxy';

function getHostsPath(): string {
  return process.platform === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';
}

function buildEntries(): string[] {
  return INTERCEPTED_DOMAINS.map(d => `127.0.0.1  ${d}  ${MARKER}`);
}

function readHosts(): string {
  return readFileSync(getHostsPath(), 'utf8');
}

/** Run a PowerShell script with elevation on Windows */
function runElevatedPS(script: string): void {
  const tmpScript = join(tmpdir(), `trimr-hosts-${Date.now()}.ps1`);
  writeFileSync(tmpScript, script);
  try {
    execSync(
      `powershell -Command "Start-Process powershell -ArgumentList '-ExecutionPolicy','Bypass','-File','${tmpScript}' -Verb RunAs -Wait"`,
      { stdio: 'pipe', timeout: 30000 },
    );
  } finally {
    try { unlinkSync(tmpScript); } catch { /* */ }
  }
}

/** Check if Trimr entries already exist in hosts file */
export function hasHostsEntries(): boolean {
  try {
    return readHosts().includes(MARKER);
  } catch {
    return false;
  }
}

/** Add API domain redirects to the hosts file */
export function addHostsEntries(): { success: boolean; message: string } {
  try {
    const current = readHosts();

    if (current.includes(MARKER)) {
      return { success: true, message: 'Hosts entries already present' };
    }

    const entries = buildEntries();

    if (process.platform === 'win32') {
      const script = entries
        .map(e => `Add-Content -Path '${getHostsPath()}' -Value '${e}' -Force`)
        .join('\n');
      runElevatedPS(script);
    } else {
      for (const entry of entries) {
        execSync(`echo '${entry}' | sudo tee -a "${getHostsPath()}" > /dev/null`, {
          stdio: 'pipe',
        });
      }
    }

    flushDns();

    return {
      success: true,
      message: `Added hosts entries for: ${INTERCEPTED_DOMAINS.join(', ')}`,
    };
  } catch (e) {
    return { success: false, message: `Failed to modify hosts file: ${(e as Error).message}` };
  }
}

/** Remove Trimr entries from the hosts file */
export function removeHostsEntries(): { success: boolean; message: string } {
  try {
    const current = readHosts();

    if (!current.includes(MARKER)) {
      return { success: true, message: 'No Trimr entries found in hosts file' };
    }

    if (process.platform === 'win32') {
      const script = `
$hostsPath = '${getHostsPath()}'
$content = Get-Content -Path $hostsPath | Where-Object { $_ -notmatch '${MARKER}' }
Set-Content -Path $hostsPath -Value $content -Force
`;
      runElevatedPS(script);
    } else {
      execSync(
        `grep -v '${MARKER}' "${getHostsPath()}" | sudo tee "${getHostsPath()}" > /dev/null`,
        { stdio: 'pipe' },
      );
    }

    flushDns();

    return { success: true, message: 'Hosts entries removed' };
  } catch (e) {
    return { success: false, message: `Failed to restore hosts file: ${(e as Error).message}` };
  }
}

function flushDns(): void {
  try {
    if (process.platform === 'win32') {
      execSync('ipconfig /flushdns', { stdio: 'pipe' });
    } else if (process.platform === 'darwin') {
      execSync('sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder', { stdio: 'pipe' });
    }
  } catch {
    // Non-fatal
  }
}
