import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

/** Central data directory for Trimr config, certs, and state */
export function getTrimrDir(): string {
  const dir = join(homedir(), '.trimr');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path to the PID file for the running proxy */
export function getPidFile(): string {
  return join(getTrimrDir(), 'trimr.pid');
}

/** Path to the log file */
export function getLogFile(): string {
  return join(getTrimrDir(), 'trimr.log');
}
