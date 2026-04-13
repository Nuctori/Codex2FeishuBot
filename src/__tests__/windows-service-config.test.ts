import assert from 'node:assert/strict';
import test from 'node:test';

// @ts-expect-error test-only JS helper without a separate .d.ts file
import { buildWinSWServiceXml, filterServiceEnvEntries } from '../../scripts/windows-service-config.mjs';

test('filterServiceEnvEntries keeps only safe service environment variables', () => {
  const filtered = filterServiceEnvEntries([
    { Name: 'PATH', Value: 'C:\\Windows\\System32' },
    { Name: 'CTI_HOME', Value: 'C:\\Users\\Nuctori\\.claude-to-im' },
    { Name: 'OPENAI_API_KEY', Value: 'sk-secret' },
    { Name: 'ANTHROPIC_API_KEY', Value: 'anth-secret' },
    { Name: 'CTI_FEISHU_APP_SECRET', Value: 'fs-secret' },
  ]);

  assert.deepEqual(filtered, [
    { Name: 'CTI_HOME', Value: 'C:\\Users\\Nuctori\\.claude-to-im' },
    { Name: 'PATH', Value: 'C:\\Windows\\System32' },
  ]);
});

test('buildWinSWServiceXml does not serialize service passwords or secret env vars', () => {
  const xml = buildWinSWServiceXml({
    serviceName: 'ClaudeToIMBridge',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    daemonPath: 'C:\\repo\\dist\\daemon.mjs',
    workingDirectory: 'C:\\repo',
    logDirectory: 'C:\\Users\\Nuctori\\.claude-to-im\\logs',
    envEntries: [
      { Name: 'CTI_HOME', Value: 'C:\\Users\\Nuctori\\.claude-to-im' },
      { Name: 'PATH', Value: 'C:\\Windows\\System32' },
    ],
  });

  assert.match(xml, /<env name="CTI_HOME"/);
  assert.doesNotMatch(xml, /OPENAI_API_KEY|ANTHROPIC_API_KEY|CTI_FEISHU_APP_SECRET/);
  assert.doesNotMatch(xml, /<password>/);
  assert.doesNotMatch(xml, /<serviceaccount>/);
});
