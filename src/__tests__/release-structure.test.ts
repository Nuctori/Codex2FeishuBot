import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SRC_DIR = path.resolve(process.cwd(), 'src');
const BLOCKED_PATTERNS = [
  'claude-to-im/src/lib/bridge',
  'node_modules/claude-to-im/src/lib/bridge',
];

function listFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'bridge') continue;
      files.push(...listFiles(fullPath));
      continue;
    }
    if (entry.name.endsWith('.ts')) {
      if (entry.name === 'release-structure.test.ts') continue;
      files.push(fullPath);
    }
  }
  return files;
}

test('app source no longer imports bridge internals from node_modules', () => {
  const offenders: string[] = [];
  for (const filePath of listFiles(SRC_DIR)) {
    const text = fs.readFileSync(filePath, 'utf8');
    if (BLOCKED_PATTERNS.some((pattern) => text.includes(pattern))) {
      offenders.push(path.relative(process.cwd(), filePath));
    }
  }

  assert.deepEqual(offenders, []);
});
