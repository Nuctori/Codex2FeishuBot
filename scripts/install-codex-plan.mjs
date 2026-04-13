import path from 'node:path';

export const CODEX_SKILL_NAME = 'claude-to-im';
export const COPY_EXCLUDED_SEGMENTS = new Set([
  '.git',
  'dist',
  'node_modules',
]);
export const COPY_EXCLUDED_BASENAMES = new Set([
  '.DS_Store',
]);

export function resolveCodexInstallPlan({
  homeDir,
  sourceDir,
  skillName = CODEX_SKILL_NAME,
  link = false,
}) {
  if (!homeDir) {
    throw new Error('homeDir is required');
  }
  if (!sourceDir) {
    throw new Error('sourceDir is required');
  }

  const resolvedHomeDir = path.resolve(homeDir);
  const resolvedSourceDir = path.resolve(sourceDir);
  const codexSkillsDir = path.join(resolvedHomeDir, '.codex', 'skills');
  const targetDir = path.join(codexSkillsDir, skillName);

  return {
    skillName,
    homeDir: resolvedHomeDir,
    sourceDir: resolvedSourceDir,
    codexSkillsDir,
    targetDir,
    link,
  };
}

export function shouldExcludeCodexCopyPath(relativePath) {
  const normalized = String(relativePath ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');

  if (!normalized || normalized === '.') {
    return false;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return false;
  }

  if (COPY_EXCLUDED_BASENAMES.has(segments.at(-1))) {
    return true;
  }

  return segments.some((segment) => COPY_EXCLUDED_SEGMENTS.has(segment));
}
