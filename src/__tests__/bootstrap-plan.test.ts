import assert from 'node:assert/strict';
import test from 'node:test';

async function loadBootstrapHelper(): Promise<any> {
  // @ts-ignore test-only JS helper without a separate .d.ts file
  return import('../../scripts/bootstrap-plan.mjs');
}

test('resolveBootstrapPlan defaults to local build-only flow', async () => {
  const { resolveBootstrapPlan } = await loadBootstrapHelper();
  const plan = resolveBootstrapPlan({
    repoRoot: 'D:\\work\\Codex2FeishuBot',
    platform: 'win32',
    argv: [],
  });

  assert.equal(plan.install, false);
  assert.equal(plan.link, false);
  assert.equal(plan.smoke, false);
  assert.equal(plan.doctor, false);
  assert.equal(plan.repoRoot, 'D:\\work\\Codex2FeishuBot');
  assert.equal(plan.installScript, 'D:\\work\\Codex2FeishuBot\\scripts\\install-codex.ps1');
  assert.equal(plan.doctorScript, 'D:\\work\\Codex2FeishuBot\\scripts\\doctor.ps1');
});

test('parseBootstrapArgs normalizes link, config, and chat-id into an installable smoke plan', async () => {
  const { parseBootstrapArgs } = await loadBootstrapHelper();
  const plan = parseBootstrapArgs([
    '--link',
    '--doctor',
    '--config',
    'C:\\Users\\Nuctori\\.claude-to-im\\config.env',
    '--chat-id',
    'oc_123',
    '--keep',
  ]);

  assert.equal(plan.install, true);
  assert.equal(plan.link, true);
  assert.equal(plan.smoke, true);
  assert.equal(plan.doctor, true);
  assert.equal(plan.keep, true);
  assert.equal(plan.configFile, 'C:\\Users\\Nuctori\\.claude-to-im\\config.env');
  assert.equal(plan.chatId, 'oc_123');
});

test('parseBootstrapArgs rejects chat-id without config', async () => {
  const { parseBootstrapArgs } = await loadBootstrapHelper();
  assert.throws(() => parseBootstrapArgs(['--chat-id', 'oc_123']), /requires --config/);
});
