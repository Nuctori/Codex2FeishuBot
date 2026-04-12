#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function parseEnvText(content) {
  const entries = new Map();

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = rawLine.indexOf('=');
    if (eqIdx === -1) continue;

    const key = rawLine.slice(0, eqIdx).trim();
    if (!key) continue;

    let value = rawLine.slice(eqIdx + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      if (value.startsWith('"')) {
        try {
          value = JSON.parse(value);
        } catch {
          value = value.slice(1, -1);
        }
      } else {
        value = value.slice(1, -1);
      }
    }

    entries.set(key, value);
  }

  return entries;
}

export function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return new Map();
  }

  return parseEnvText(fs.readFileSync(filePath, 'utf8'));
}

function printUsage() {
  console.error('Usage: node scripts/config-env.mjs <get|json|export-nul> <config-path> [key|prefixes...]');
}

function main(argv) {
  const [command, filePath, ...rest] = argv;
  if (!command || !filePath) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const entries = loadEnvFile(filePath);

  if (command === 'get') {
    const [key] = rest;
    if (!key) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    const value = entries.get(key);
    if (value !== undefined) {
      process.stdout.write(String(value));
    }
    return;
  }

  if (command === 'json') {
    process.stdout.write(`${JSON.stringify(Object.fromEntries(entries))}\n`);
    return;
  }

  if (command === 'export-nul') {
    const prefixes = rest;
    for (const [key, value] of entries) {
      if (prefixes.length > 0 && !prefixes.some((prefix) => key.startsWith(prefix))) {
        continue;
      }
      process.stdout.write(`${key}=${value}\0`);
    }
    return;
  }

  printUsage();
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2));
}
