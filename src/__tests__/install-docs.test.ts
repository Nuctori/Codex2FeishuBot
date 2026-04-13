import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const README_EN = path.resolve(process.cwd(), 'README.md');
const README_CN = path.resolve(process.cwd(), 'README_CN.md');
const INSTALLER_PS1 = path.resolve(process.cwd(), 'scripts', 'install-codex.ps1');

test('windows installer script is included in the repo', () => {
  assert.equal(fs.existsSync(INSTALLER_PS1), true);
});

test('README documents the PowerShell Codex installer', () => {
  const text = fs.readFileSync(README_EN, 'utf8');
  assert.match(text, /install-codex\.ps1/);
});

test('README_CN documents the PowerShell Codex installer', () => {
  const text = fs.readFileSync(README_CN, 'utf8');
  assert.match(text, /install-codex\.ps1/);
});
