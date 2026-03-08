#!/usr/bin/env node
/**
 * TokenDiff CLI entry point.
 * Works as: npx tokendiff          → start the proxy
 *           npx tokendiff setup    → configure AI tools
 */
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const command = process.argv[2];

if (command === 'setup') {
  await import(join(root, 'dist', 'setup.js'));
} else {
  // Pass remaining args via process.argv (already available)
  await import(join(root, 'dist', 'proxy.js'));
}
