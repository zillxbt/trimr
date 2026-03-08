#!/usr/bin/env node
/**
 * Trimr CLI entry point.
 * Usage: trimr <command>
 */
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const command = process.argv[2];

if (command === 'install') {
  const { install } = await import(join(root, 'dist', 'install', 'installer.js'));
  await install();
} else if (command === 'uninstall') {
  const { uninstall } = await import(join(root, 'dist', 'install', 'installer.js'));
  await uninstall();
} else {
  // Delegate to the main CLI (status, start, stop, help, etc.)
  await import(join(root, 'dist', 'cli.js'));
}
