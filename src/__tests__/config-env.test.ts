import assert from 'node:assert/strict';
import test from 'node:test';

// @ts-expect-error test-only JS helper without a separate .d.ts file
import { parseEnvText } from '../../scripts/config-env.mjs';

test('parseEnvText keeps spaces and shell-special characters intact', () => {
  const entries = parseEnvText([
    'CTI_DEFAULT_WORKDIR=/Users/me/Code Projects/app',
    'CTI_FEISHU_APP_SECRET=abc$123#tail',
    "OPENAI_API_KEY='sk-test-value'",
  ].join('\n'));

  assert.equal(entries.get('CTI_DEFAULT_WORKDIR'), '/Users/me/Code Projects/app');
  assert.equal(entries.get('CTI_FEISHU_APP_SECRET'), 'abc$123#tail');
  assert.equal(entries.get('OPENAI_API_KEY'), 'sk-test-value');
});

test('parseEnvText decodes double-quoted json-style values', () => {
  const entries = parseEnvText('CTI_DEFAULT_MODEL="gpt-5 mini"\n');

  assert.equal(entries.get('CTI_DEFAULT_MODEL'), 'gpt-5 mini');
});
