import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SUPERVISOR_PATH = path.resolve(process.cwd(), 'scripts', 'supervisor-windows.ps1');
const SUPERVISOR_TEXT = fs.readFileSync(SUPERVISOR_PATH, 'utf8');

test('NSSM install no longer prompts for a Windows password', () => {
  assert.doesNotMatch(SUPERVISOR_TEXT, /Get-Credential/);
  assert.doesNotMatch(SUPERVISOR_TEXT, /ObjectName\s+\$currentUser\s+\$plainPwd/);
  assert.match(SUPERVISOR_TEXT, /Secure auto-install via NSSM is disabled/);
});

test('Windows supervisor exposes stderr logs in recovery guidance', () => {
  assert.match(SUPERVISOR_TEXT, /bridge-error\.log/);
  assert.match(SUPERVISOR_TEXT, /Recent stderr:/);
  assert.match(SUPERVISOR_TEXT, /shows bridge\.log \+ bridge-error\.log/);
});

test('Windows supervisor waits with a configurable startup timeout', () => {
  assert.match(SUPERVISOR_TEXT, /\$StartTimeoutSeconds = 20/);
  assert.match(SUPERVISOR_TEXT, /Wait-ForBridgeLaunch/);
  assert.doesNotMatch(SUPERVISOR_TEXT, /Start-Sleep -Seconds 3/);
});
