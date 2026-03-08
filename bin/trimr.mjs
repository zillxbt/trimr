#!/usr/bin/env node
/**
 * Trimr CLI entry point.
 * Usage: trimr <command>
 */
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const command = process.argv[2];

if (command === 'install') {
  const { install } = await import(pathToFileURL(join(root, 'dist', 'install', 'installer.js')).href);
  await install();
} else if (command === 'uninstall') {
  const { uninstall } = await import(pathToFileURL(join(root, 'dist', 'install', 'installer.js')).href);
  await uninstall();
} else {
  await import(pathToFileURL(join(root, 'dist', 'cli.js')).href);
}
