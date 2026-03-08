/**
 * Background service management — start/stop Trimr as a persistent process.
 *
 * Uses a simple PID-file approach that works cross-platform without external
 * dependencies (node-windows/node-mac/systemd). The installer can optionally
 * set up OS-level autostart.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, openSync, mkdirSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { getPidFile, getLogFile, getTrimrDir } from './paths.js';
import { getCACertPath } from './certificate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

/** Check if the proxy process is running */
export function isRunning(): boolean {
  const pid = readPid();
  if (pid === null) return false;

  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    // Process not found — stale PID file
    cleanPid();
    return false;
  }
}

/** Read PID from file */
function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(getPidFile(), 'utf8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Write PID to file */
function writePid(pid: number): void {
  writeFileSync(getPidFile(), String(pid));
}

/** Remove stale PID file */
function cleanPid(): void {
  try { unlinkSync(getPidFile()); } catch { /* ignore */ }
}

/** Start the proxy as a background process.
 *  Pass extra env vars to configure mode (e.g. TRIMR_MODE, PORT). */
export function startService(extraEnv?: Record<string, string>): { success: boolean; message: string; pid?: number } {
  if (isRunning()) {
    const pid = readPid()!;
    return { success: true, message: `Trimr already running (PID ${pid})`, pid };
  }

  // Find the proxy entry point
  const proxyScript = join(PROJECT_ROOT, 'src', 'proxy.ts');
  const proxyDist = join(PROJECT_ROOT, 'dist', 'proxy.js');

  let cmd: string;
  let args: string[];

  if (existsSync(proxyDist)) {
    cmd = process.execPath; // node
    args = [proxyDist];
  } else {
    // Dev mode — use tsx
    const tsxBin = join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
    cmd = existsSync(tsxBin) ? tsxBin : 'tsx';
    args = [proxyScript];
  }

  const logFile = getLogFile();

  // Log the launch command and env for debugging
  const envLog = extraEnv ? ' env=' + JSON.stringify(extraEnv) : '';
  appendFileSync(logFile, `\n[${new Date().toISOString()}] Starting Trimr: "${cmd}" ${args.map(a => `"${a}"`).join(' ')}${envLog}\n`);

  const out = openSync(logFile, 'a');
  const err = openSync(logFile, 'a');

  // On Windows, shell:true is needed for .cmd shims (tsx) and detached processes,
  // but it splits on spaces. Wrap the command in quotes to handle paths like
  // "C:\Program Files\nodejs\node.exe".
  const isWin = process.platform === 'win32';
  const spawnCmd = isWin ? `"${cmd}"` : cmd;
  const spawnArgs = isWin ? args.map(a => `"${a}"`) : args;

  const child = spawn(spawnCmd, spawnArgs, {
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      TOKENDIFF_DASHBOARD: 'false',
      ...extraEnv,
    },
    cwd: PROJECT_ROOT,
    shell: isWin,
  });

  child.on('error', (spawnErr) => {
    appendFileSync(logFile, `[${new Date().toISOString()}] Spawn error: ${spawnErr.message}\n`);
  });

  if (child.pid) {
    writePid(child.pid);
    child.unref();
    return { success: true, message: `Trimr started (PID ${child.pid})`, pid: child.pid };
  }

  return { success: false, message: 'Failed to start Trimr process — check log: ' + logFile };
}

/** Stop the running proxy */
export function stopService(): { success: boolean; message: string } {
  const pid = readPid();

  if (pid === null || !isRunning()) {
    cleanPid();
    return { success: true, message: 'Trimr is not running' };
  }

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'pipe' });
    } else {
      process.kill(pid, 'SIGTERM');
      // Give it a moment to shut down gracefully
      try {
        execSync(`sleep 1 && kill -0 ${pid} 2>/dev/null && kill -9 ${pid}`, { stdio: 'pipe' });
      } catch { /* already dead — good */ }
    }
    cleanPid();
    return { success: true, message: `Trimr stopped (was PID ${pid})` };
  } catch (e) {
    cleanPid();
    return { success: false, message: `Error stopping Trimr: ${(e as Error).message}` };
  }
}

// ── Autostart setup ───────────────────────────────────────────────────────────

export function setupAutostart(): { success: boolean; message: string } {
  const platform = process.platform;
  const trimrDir = getTrimrDir();

  try {
    if (platform === 'win32') {
      // Create a VBS script in the Startup folder to run Trimr silently
      const startupDir = join(
        process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
        'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
      );
      const vbsPath = join(startupDir, 'trimr.vbs');
      const cliDist = join(PROJECT_ROOT, 'dist', 'cli.js');
      const cliSrc = join(PROJECT_ROOT, 'src', 'cli.ts');

      // Determine whether to use node (dist) or tsx (dev)
      // VBS requires doubled quotes inside a quoted string: ""path with spaces""
      let vbsCmd: string;
      if (existsSync(join(PROJECT_ROOT, 'dist', 'proxy.js'))) {
        // Production: use node directly
        vbsCmd = `"""${process.execPath}"" ""${cliDist}"" start"`;
      } else {
        // Dev: use tsx.cmd (must use .cmd on Windows for direct execution)
        const tsxBin = join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx.cmd');
        vbsCmd = `"""${tsxBin}"" ""${cliSrc}"" start"`;
      }
      // Set intercept env vars, then launch hidden
      const caCertPath = getCACertPath();
      const vbs = `Set WshShell = CreateObject("WScript.Shell")\n` +
        `Set WshEnv = WshShell.Environment("Process")\n` +
        `WshEnv("TRIMR_MODE") = "intercept"\n` +
        `WshEnv("PORT") = "443"\n` +
        `WshEnv("TOKENDIFF_DASHBOARD") = "false"\n` +
        `WshEnv("NODE_EXTRA_CA_CERTS") = "${caCertPath}"\n` +
        `WshShell.Run ${vbsCmd}, 0, False\n`;

      writeFileSync(vbsPath, vbs);
      return { success: true, message: `Autostart added: ${vbsPath}` };
    }

    if (platform === 'darwin') {
      const plistPath = join(process.env.HOME ?? '~', 'Library', 'LaunchAgents', 'com.trimr.proxy.plist');
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.trimr.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${join(PROJECT_ROOT, 'dist', 'proxy.js')}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${getLogFile()}</string>
  <key>StandardErrorPath</key><string>${getLogFile()}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TOKENDIFF_DASHBOARD</key><string>false</string>
    <key>TRIMR_MODE</key><string>intercept</string>
    <key>PORT</key><string>443</string>
    <key>NODE_EXTRA_CA_CERTS</key><string>${getCACertPath()}</string>
  </dict>
</dict>
</plist>`;
      writeFileSync(plistPath, plist);
      execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
      return { success: true, message: `LaunchAgent installed: ${plistPath}` };
    }

    // Linux — systemd user service
    const serviceDir = join(process.env.HOME ?? '~', '.config', 'systemd', 'user');
    mkdirSync(serviceDir, { recursive: true });
    const servicePath = join(serviceDir, 'trimr.service');
    const service = `[Unit]
Description=Trimr Token Proxy
After=network.target

[Service]
ExecStart="${process.execPath}" "${join(PROJECT_ROOT, 'dist', 'proxy.js')}"
Restart=on-failure
Environment=TOKENDIFF_DASHBOARD=false
Environment=TRIMR_MODE=intercept
Environment=PORT=443
Environment=NODE_EXTRA_CA_CERTS=${getCACertPath()}

[Install]
WantedBy=default.target
`;
    writeFileSync(servicePath, service);
    execSync('systemctl --user daemon-reload && systemctl --user enable trimr', { stdio: 'pipe' });
    return { success: true, message: `Systemd user service installed: ${servicePath}` };
  } catch (e) {
    return { success: false, message: `Autostart setup failed: ${(e as Error).message}` };
  }
}

export function removeAutostart(): { success: boolean; message: string } {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      const startupDir = join(
        process.env.APPDATA ?? '',
        'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
      );
      const vbsPath = join(startupDir, 'trimr.vbs');
      if (existsSync(vbsPath)) unlinkSync(vbsPath);
      return { success: true, message: 'Autostart removed' };
    }

    if (platform === 'darwin') {
      const plistPath = join(process.env.HOME ?? '~', 'Library', 'LaunchAgents', 'com.trimr.proxy.plist');
      try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' }); } catch { /* */ }
      if (existsSync(plistPath)) unlinkSync(plistPath);
      return { success: true, message: 'LaunchAgent removed' };
    }

    // Linux
    try { execSync('systemctl --user disable trimr && systemctl --user stop trimr', { stdio: 'pipe' }); } catch { /* */ }
    const servicePath = join(process.env.HOME ?? '~', '.config', 'systemd', 'user', 'trimr.service');
    if (existsSync(servicePath)) unlinkSync(servicePath);
    try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch { /* */ }
    return { success: true, message: 'Systemd service removed' };
  } catch (e) {
    return { success: false, message: `Autostart removal failed: ${(e as Error).message}` };
  }
}
