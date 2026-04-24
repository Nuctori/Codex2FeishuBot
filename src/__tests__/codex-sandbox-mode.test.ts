import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSandboxMode } from '../codex-provider.js';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test('resolveSandboxMode respects explicit env override', () => {
  const old = process.env.CTI_CODEX_SANDBOX_MODE;
  process.env.CTI_CODEX_SANDBOX_MODE = 'read-only';
  try {
    assert.equal(resolveSandboxMode('D:\\repo', 'win32', 'C:'), 'read-only');
  } finally {
    restoreEnv('CTI_CODEX_SANDBOX_MODE', old);
  }
});

test('resolveSandboxMode defaults to danger-full-access for Windows non-system drives', () => {
  const old = process.env.CTI_CODEX_SANDBOX_MODE;
  delete process.env.CTI_CODEX_SANDBOX_MODE;
  try {
    assert.equal(resolveSandboxMode('D:\\lua\\fireBookStore-backend\\firebookstore-dotnet', 'win32', 'C:'), 'danger-full-access');
  } finally {
    restoreEnv('CTI_CODEX_SANDBOX_MODE', old);
  }
});

test('resolveSandboxMode keeps workspace-write for Windows system drive workspaces', () => {
  const old = process.env.CTI_CODEX_SANDBOX_MODE;
  delete process.env.CTI_CODEX_SANDBOX_MODE;
  try {
    assert.equal(resolveSandboxMode('C:\\Users\\Nuctori\\repo', 'win32', 'C:'), 'workspace-write');
  } finally {
    restoreEnv('CTI_CODEX_SANDBOX_MODE', old);
  }
});

test('resolveSandboxMode keeps workspace-write on non-Windows platforms', () => {
  const old = process.env.CTI_CODEX_SANDBOX_MODE;
  delete process.env.CTI_CODEX_SANDBOX_MODE;
  try {
    assert.equal(resolveSandboxMode('/workspace/repo', 'linux', '/'), 'workspace-write');
  } finally {
    restoreEnv('CTI_CODEX_SANDBOX_MODE', old);
  }
});
