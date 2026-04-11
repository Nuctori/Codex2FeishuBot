import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const testsDir = path.join(repoRoot, 'src', '__tests__');
const testFiles = fs.readdirSync(testsDir)
  .filter((entry) => entry.endsWith('.test.ts'))
  .sort()
  .map((entry) => path.join('src', '__tests__', entry));

if (testFiles.length === 0) {
  console.error('No test files found under src/__tests__.');
  process.exit(1);
}

const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-home-'));
const env = {
  ...process.env,
  CTI_HOME: ctiHome,
  CTI_CODEX_HOME: path.join(ctiHome, 'codex-home'),
  CTI_CODEX_ISOLATE_HOME: 'true',
};

try {
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      '--import',
      'tsx',
      '--test-timeout=15000',
      ...testFiles,
    ],
    {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    },
  );

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  console.error(result.error ? String(result.error) : 'Tests terminated unexpectedly.');
  process.exit(1);
} finally {
  fs.rmSync(ctiHome, { recursive: true, force: true });
}
