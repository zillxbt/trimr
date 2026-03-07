/**
 * Hosts file modification — redirects API domains to 127.0.0.1.
 */
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
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

/** Read the current hosts file content */
function readHosts(): string {
  return readFileSync(getHostsPath(), 'utf8');
}

/** Write hosts file — elevated on Unix, direct on Windows (expects elevated process) */
function writeHosts(content: string): void {
  const hostsPath = getHostsPath();

  if (process.platform === 'win32') {
    // On Windows we're already running elevated (installer handles this)
    writeFileSync(hostsPath, content);
  } else {
    // Use tee via sudo to write
    execSync(`echo '${content.replace(/'/g, "'\\''")}' | sudo tee "${hostsPath}" > /dev/null`, {
      stdio: 'pipe',
    });
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
    const newContent = current.trimEnd() + '\n\n' + entries.join('\n') + '\n';

    if (process.platform === 'win32') {
      writeFileSync(getHostsPath(), newContent);
    } else {
      // Write each entry with sudo tee -a
      for (const entry of entries) {
        execSync(`echo '${entry}' | sudo tee -a "${getHostsPath()}" > /dev/null`, {
          stdio: 'pipe',
        });
      }
    }

    // Flush DNS cache
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

    const filtered = current
      .split('\n')
      .filter(line => !line.includes(MARKER))
      .join('\n')
      // Clean up multiple blank lines left behind
      .replace(/\n{3,}/g, '\n\n');

    if (process.platform === 'win32') {
      writeFileSync(getHostsPath(), filtered);
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
    // Linux: most distros auto-update, systemd-resolved can be flushed but it's not always present
  } catch {
    // Non-fatal
  }
}
