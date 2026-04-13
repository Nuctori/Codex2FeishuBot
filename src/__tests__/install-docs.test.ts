import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const README_EN = path.resolve(process.cwd(), 'README.md');
const README_CN = path.resolve(process.cwd(), 'README_CN.md');
const ZERO_DEPLOY_RUNBOOK = path.resolve(process.cwd(), 'references', 'zero-deploy-runbook.md');
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

test('zero-deploy runbook is linked from both READMEs', () => {
  assert.equal(fs.existsSync(ZERO_DEPLOY_RUNBOOK), true);
  const runbook = fs.readFileSync(ZERO_DEPLOY_RUNBOOK, 'utf8');
  assert.match(runbook, /npm run smoke:deploy/);
  assert.match(runbook, /npm run smoke:feishu/);
  assert.match(runbook, /CTI_FEISHU_APP_SECRET/);
  assert.match(fs.readFileSync(README_EN, 'utf8'), /references\/zero-deploy-runbook\.md/);
  assert.match(fs.readFileSync(README_CN, 'utf8'), /references\/zero-deploy-runbook\.md/);
});

test('zero-deploy runbook preserves readable list structure', () => {
  const runbook = fs.readFileSync(ZERO_DEPLOY_RUNBOOK, 'utf8');
  const lines = runbook.split(/\r?\n/);
  for (const expectedLine of [
    '- **人类操作者**：按顺序复制命令，完成从 clone、配置到飞书接通验证。',
    '- **AI 操作者**：在无人值守或远程协助时，按检查点执行，不泄漏密钥，不破坏现有 `~/.codex` 与 `~/.claude-to-im`。',
    '1. 不要把 `CTI_FEISHU_APP_SECRET`、`CTI_CODEX_API_KEY`、`OPENAI_API_KEY` 粘到日志、截图或聊天里。',
    '2. 真实配置文件默认放在遗留数据路径 `~/.claude-to-im/config.env`，不要提交到 git。',
    '3. `npm run smoke:deploy` 默认使用临时干净 HOME，不会写入真实 `~/.codex` skill 目录。',
    '4. 如果显式传入 `--home <path>`，脚本认为这是用户提供的目录，测试结束后不会自动删除。',
    '5. 使用 `--dry-run` 时不会复制配置、安装依赖、构建或调用飞书 API，只验证命令路径和隔离环境。',
  ]) {
    assert.equal(lines.includes(expectedLine), true, `missing standalone line: ${expectedLine}`);
  }
  const humanOperatorLine = lines.indexOf('- **人类操作者**：按顺序复制命令，完成从 clone、配置到飞书接通验证。');
  const firstSafetyLine = lines.indexOf('1. 不要把 `CTI_FEISHU_APP_SECRET`、`CTI_CODEX_API_KEY`、`OPENAI_API_KEY` 粘到日志、截图或聊天里。');
  assert.equal(lines[humanOperatorLine + 1], '');
  assert.equal(lines[firstSafetyLine + 1], '');
  assert.doesNotMatch(runbook, /人类操作者[^\n]+- \*\*AI 操作者/);
  assert.doesNotMatch(runbook, /不要把[^\n]+2\. 真实配置文件/);
});
