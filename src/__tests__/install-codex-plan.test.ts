import assert from 'node:assert/strict';
import test from 'node:test';

async function loadInstallHelper(): Promise<any> {
  // @ts-ignore test-only JS helper without a separate .d.ts file
  return import('../../scripts/install-codex-plan.mjs');
}

test('resolveCodexInstallPlan targets ~/.codex/skills/claude-to-im', async () => {
  const { CODEX_SKILL_NAME, resolveCodexInstallPlan } = await loadInstallHelper();
  const plan = resolveCodexInstallPlan({
    homeDir: 'C:\\Users\\Nuctori',
    sourceDir: 'D:\\work\\codex-feishu-bridge',
    link: true,
  });

  assert.equal(plan.skillName, CODEX_SKILL_NAME);
  assert.equal(plan.codexSkillsDir, 'C:\\Users\\Nuctori\\.codex\\skills');
  assert.equal(plan.targetDir, 'C:\\Users\\Nuctori\\.codex\\skills\\claude-to-im');
  assert.equal(plan.sourceDir, 'D:\\work\\codex-feishu-bridge');
  assert.equal(plan.link, true);
});

test('shouldExcludeCodexCopyPath filters git, build outputs, node_modules, and macOS metadata', async () => {
  const { shouldExcludeCodexCopyPath } = await loadInstallHelper();
  assert.equal(shouldExcludeCodexCopyPath('.git\\HEAD'), true);
  assert.equal(shouldExcludeCodexCopyPath('node_modules\\tsx\\dist\\index.js'), true);
  assert.equal(shouldExcludeCodexCopyPath('dist/windows-watchdog.mjs'), true);
  assert.equal(shouldExcludeCodexCopyPath('docs/.DS_Store'), true);
  assert.equal(shouldExcludeCodexCopyPath('src/main.ts'), false);
  assert.equal(shouldExcludeCodexCopyPath('README.md'), false);
});
