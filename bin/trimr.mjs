#!/usr/bin/env node
/**
 * Trimr CLI entry point.
 * Usage: trimr <command>
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const target = join(root, 'src', 'cli.ts');

// Find tsx
const localTsx = join(root, 'node_modules', '.bin', 'tsx');
const tsx = existsSync(localTsx) ? localTsx : 'tsx';

const result = spawnSync(
  process.execPath,
  ['--import', `${tsx}/esm`, target, ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);

process.exit(result.status ?? 0);
