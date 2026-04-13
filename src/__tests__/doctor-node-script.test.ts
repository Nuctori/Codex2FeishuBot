import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const DOCTOR_NODE_PATH = path.resolve(process.cwd(), 'scripts', 'doctor-node.mjs');
const DOCTOR_NODE_TEXT = fs.readFileSync(DOCTOR_NODE_PATH, 'utf8');

test('doctor-node inspects both stdout and stderr bridge logs', () => {
  assert.match(DOCTOR_NODE_TEXT, /bridge-error\.log/);
  assert.match(DOCTOR_NODE_TEXT, /recentLogHasErrors\(\[LOG_FILE, ERROR_LOG_FILE\]\)/);
  assert.match(DOCTOR_NODE_TEXT, /No recent errors in logs/);
});
