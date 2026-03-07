#!/usr/bin/env node
/**
 * TokenDiff CLI entry point.
 * Works as: npx tokendiff          → start the proxy
 *           npx tokendiff setup    → configure AI tools
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const command = process.argv[2];
const isSetup = command === 'setup';

const target = isSetup
  ? join(root, 'src', 'setup.ts')
  : join(root, 'src', 'proxy.ts');

// Find tsx — prefer local node_modules, fall back to global
const localTsx = join(root, 'node_modules', '.bin', 'tsx');
const tsx = existsSync(localTsx) ? localTsx : 'tsx';

const result = spawnSync(
  process.execPath,
  ['--import', `${tsx}/esm`, target, ...process.argv.slice(isSetup ? 3 : 2)],
  { stdio: 'inherit', env: process.env },
);

process.exit(result.status ?? 0);
