#!/usr/bin/env node
/**
 * TokenDiff CLI entry point.
 * Works as: npx tokendiff          → start the proxy
 *           npx tokendiff setup    → configure AI tools
 */
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const command = process.argv[2];

if (command === 'setup') {
  await import(pathToFileURL(join(root, 'dist', 'setup.js')).href);
} else {
  await import(pathToFileURL(join(root, 'dist', 'proxy.js')).href);
}
