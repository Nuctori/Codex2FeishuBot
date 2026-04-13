import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const FEISHU_SMOKE_PATH = path.resolve(process.cwd(), 'scripts', 'feishu-smoke.mjs');
const SMOKE_DEPLOY_PATH = path.resolve(process.cwd(), 'scripts', 'smoke-deploy.mjs');

test('feishu smoke dry-run validates config without network calls', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-smoke-test-'));
  try {
    const configPath = path.join(tempDir, 'config.env');
    fs.writeFileSync(configPath, [
      'CTI_RUNTIME=codex',
      'CTI_ENABLED_CHANNELS=feishu',
      'CTI_FEISHU_APP_ID=cli_test_app',
      'CTI_FEISHU_APP_SECRET=test_secret',
      'CTI_FEISHU_DOMAIN=feishu',
      '',
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      FEISHU_SMOKE_PATH,
      '--config',
      configPath,
      '--chat-id',
      'oc_test_chat',
      '--dry-run',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Codex ↔ Feishu smoke/);
    assert.match(result.stdout, /\[DRY-RUN\] Feishu API calls skipped\./);
    assert.match(result.stdout, /Send message: yes \(oc_test_chat\)/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('feishu smoke defaults config lookup to CTI_HOME', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-smoke-cti-home-test-'));
  try {
    const ctiHome = path.join(tempDir, '.claude-to-im');
    fs.mkdirSync(ctiHome, { recursive: true });
    const configPath = path.join(ctiHome, 'config.env');
    fs.writeFileSync(configPath, [
      'CTI_RUNTIME=codex',
      'CTI_ENABLED_CHANNELS=feishu',
      'CTI_FEISHU_APP_ID=cli_test_app',
      'CTI_FEISHU_APP_SECRET=test_secret',
      '',
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      FEISHU_SMOKE_PATH,
      '--dry-run',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        CTI_HOME: ctiHome,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.replace(/\\/g, '/'), new RegExp(`Config: ${configPath.replace(/\\/g, '/').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('zero-deploy smoke dry-run uses isolated home and does not execute install or Feishu calls', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-deploy-smoke-test-'));
  try {
    const homeDir = path.join(tempDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    const markerPath = path.join(homeDir, 'must-survive.txt');
    fs.writeFileSync(markerPath, 'do not delete user-provided --home');
    const configPath = path.join(tempDir, 'config.env');
    fs.writeFileSync(configPath, [
      'CTI_RUNTIME=codex',
      'CTI_ENABLED_CHANNELS=feishu',
      'CTI_FEISHU_APP_ID=cli_test_app',
      'CTI_FEISHU_APP_SECRET=test_secret',
      '',
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      SMOKE_DEPLOY_PATH,
      '--home',
      homeDir,
      '--config',
      configPath,
      '--chat-id',
      'oc_test_chat',
      '--dry-run',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_HOME: path.join(tempDir, 'real-codex-home-that-must-not-be-used'),
        CTI_HOME: path.join(tempDir, 'real-cti-home-that-must-not-be-used'),
        OPENAI_API_KEY: 'must_not_leak_to_smoke_env',
        CTI_FEISHU_APP_SECRET: 'must_not_leak_feishu_secret',
        FEISHU_TENANT_TOKEN: 'must_not_leak_feishu_token',
        LARK_APP_SECRET: 'must_not_leak_lark_secret',
      },
    });

    const stdout = result.stdout.replace(/\\/g, '/');
    const normalizedHome = homeDir.replace(/\\/g, '/');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Codex .* Feishu zero-deploy smoke/);
    assert.match(stdout, new RegExp(`Isolated CODEX_HOME: ${normalizedHome.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}/\\.codex`));
    assert.match(stdout, new RegExp(`Isolated CTI_HOME: ${normalizedHome.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}/\\.claude-to-im`));
    assert.match(result.stdout, /Sensitive env stripped: yes/);
    assert.match(result.stdout, /\[DRY-RUN\] Copy\/install\/build skipped\./);
    assert.match(result.stdout, /\[DRY-RUN\] Config copy skipped:/);
    assert.match(result.stdout, /\$ (?:npm|npm\.cmd|.+npm-cli\.js) ci --ignore-scripts --prefer-offline --no-audit --no-fund/);
    assert.match(result.stdout, /doctor-node\.mjs/);
    assert.match(result.stdout, /feishu-smoke\.mjs/);
    assert.doesNotMatch(result.stdout, /real-codex-home-that-must-not-be-used/);
    assert.doesNotMatch(result.stdout, /real-cti-home-that-must-not-be-used/);
    assert.doesNotMatch(result.stdout, /must_not_leak_to_smoke_env/);
    assert.doesNotMatch(result.stdout, /must_not_leak_feishu_secret/);
    assert.doesNotMatch(result.stdout, /must_not_leak_feishu_token/);
    assert.doesNotMatch(result.stdout, /must_not_leak_lark_secret/);
    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(fs.existsSync(path.join(homeDir, '.claude-to-im', 'config.env')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('zero-deploy smoke passes isolated sanitized env to real child processes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-deploy-spawn-env-test-'));
  try {
    const homeDir = path.join(tempDir, 'home');
    const binDir = path.join(tempDir, 'bin');
    const probePath = path.join(tempDir, 'npm-probe.mjs');
    const recordPath = path.join(tempDir, 'records.jsonl');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(probePath, [
      "import fs from 'node:fs';",
      "const keys = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CTI_CODEX_HOME', 'CTI_CODEX_ISOLATE_HOME', 'CTI_HOME', 'OPENAI_API_KEY', 'CTI_FEISHU_APP_SECRET', 'FEISHU_TENANT_TOKEN', 'LARK_APP_SECRET'];",
      'const env = Object.fromEntries(keys.map((key) => [key, process.env[key] || null]));',
      'fs.appendFileSync(process.env.NPM_PROBE_RECORD, JSON.stringify({ argv: process.argv.slice(2), env }) + "\\n");',
    ].join('\n'));

    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, 'npm.cmd'), '@echo off\r\n"%NODE_EXE%" "%NPM_PROBE_JS%" %*\r\n');
    } else {
      const npmPath = path.join(binDir, 'npm');
      fs.writeFileSync(npmPath, '#!/bin/sh\nexec "$NODE_EXE" "$NPM_PROBE_JS" "$@"\n');
      fs.chmodSync(npmPath, 0o755);
    }

    const result = spawnSync(process.execPath, [
      SMOKE_DEPLOY_PATH,
      '--home',
      homeDir,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        NODE_EXE: process.execPath,
        NPM_PROBE_JS: probePath,
        NPM_PROBE_RECORD: recordPath,
        npm_execpath: '',
        CODEX_HOME: path.join(tempDir, 'real-codex-home-that-must-not-be-used'),
        CTI_HOME: path.join(tempDir, 'real-cti-home-that-must-not-be-used'),
        OPENAI_API_KEY: 'must_not_reach_child',
        CTI_FEISHU_APP_SECRET: 'must_not_reach_child_feishu',
        FEISHU_TENANT_TOKEN: 'must_not_reach_child_token',
        LARK_APP_SECRET: 'must_not_reach_child_lark',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const records = fs.readFileSync(recordPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.argv), [['ci', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'], ['run', 'build']]);
    for (const record of records) {
      assert.equal(record.env.HOME, homeDir);
      assert.equal(record.env.USERPROFILE, homeDir);
      assert.equal(record.env.CODEX_HOME, path.join(homeDir, '.codex'));
      assert.equal(record.env.CTI_CODEX_HOME, path.join(homeDir, '.codex'));
      assert.equal(record.env.CTI_CODEX_ISOLATE_HOME, 'true');
      assert.equal(record.env.CTI_HOME, path.join(homeDir, '.claude-to-im'));
      assert.equal(record.env.OPENAI_API_KEY, null);
      assert.equal(record.env.CTI_FEISHU_APP_SECRET, null);
      assert.equal(record.env.FEISHU_TENANT_TOKEN, null);
      assert.equal(record.env.LARK_APP_SECRET, null);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
