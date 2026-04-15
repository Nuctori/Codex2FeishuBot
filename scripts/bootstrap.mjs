#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveBootstrapPlan } from './bootstrap-plan.mjs';

function usage() {
  return [
    'Usage:',
    '  npm run bootstrap -- [--install] [--link] [--doctor] [--smoke] [--config <config.env>] [--chat-id <chat_id>] [--keep] [--dry-run]',
    '',
    'Default behavior:',
    '  - Install dependencies with npm ci (or npm install when no lockfile exists)',
    '  - Build the daemon bundle',
    '',
    'Optional behavior:',
    '  --install   Install the skill into ~/.codex/skills/claude-to-im',
    '  --link      Install as a live link/junction instead of a copy (implies --install)',
    '  --doctor    Run the bridge doctor script after build',
    '  --smoke     Run zero-deploy smoke after build',
    '  --config    Pass config.env into zero-deploy smoke and Feishu connectivity checks',
    '  --chat-id   Send a real Feishu smoke message (requires --config)',
    '  --keep      Preserve the temporary smoke HOME for inspection',
    '  --skip-deps Skip npm ci/npm install',
    '  --skip-build Skip npm run build',
    '  --dry-run   Print commands without executing them',
  ].join('\n');
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(' ');
  console.log(`\n$ ${printable}`);
  if (options.dryRun) {
    return;
  }

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
  });

  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  if (result.error) {
    throw result.error;
  }
}

function runNpm(repoRoot, args, dryRun) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    run(process.execPath, [npmExecPath, ...args], { cwd: repoRoot, dryRun });
    return;
  }

  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: repoRoot,
    dryRun,
    shell: process.platform === 'win32',
  });
}

function runPlatformScript(scriptPath, args, { repoRoot, dryRun }) {
  if (process.platform === 'win32') {
    run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
      cwd: repoRoot,
      dryRun,
    });
    return;
  }

  run('bash', [scriptPath, ...args], {
    cwd: repoRoot,
    dryRun,
  });
}

function printSummary(plan) {
  console.log('\nBootstrap summary');
  console.log(`- Repo: ${plan.repoRoot}`);
  console.log(`- Install skill: ${plan.install ? (plan.link ? 'yes (link)' : 'yes (copy)') : 'no'}`);
  console.log(`- Run doctor: ${plan.doctor ? 'yes' : 'no'}`);
  console.log(`- Run smoke: ${plan.smoke ? 'yes' : 'no'}`);
  console.log(`- Feishu config: ${plan.configFile ? plan.configFile : 'not provided'}`);
  console.log(`- Chat ID: ${plan.chatId || 'not provided'}`);
  console.log(`- Dry run: ${plan.dryRun ? 'yes' : 'no'}`);
}

function printManualBoundary() {
  console.log('\nManual boundary');
  console.log('- Feishu app creation, scope approval, callback registration, and publish approval still require a human operator.');
  console.log('- This bootstrap automates local install/build/doctor/smoke once the repository and credentials are available.');
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  const plan = resolveBootstrapPlan({
    repoRoot,
    argv: process.argv.slice(2),
  });

  if (plan.help) {
    console.log(usage());
    return;
  }

  printSummary(plan);

  if (!plan.skipDeps) {
    runNpm(repoRoot, [fs.existsSync(plan.packageLockPath) ? 'ci' : 'install'], plan.dryRun);
  }

  if (!plan.skipBuild) {
    runNpm(repoRoot, ['run', 'build'], plan.dryRun);
  }

  if (plan.doctor) {
    runPlatformScript(plan.doctorScript, [], { repoRoot, dryRun: plan.dryRun });
  }

  if (plan.smoke) {
    const smokeArgs = ['run', 'smoke:deploy', '--'];
    if (plan.configFile) {
      smokeArgs.push('--config', plan.configFile);
    }
    if (plan.chatId) {
      smokeArgs.push('--chat-id', plan.chatId);
    }
    if (plan.keep) {
      smokeArgs.push('--keep');
    }
    if (plan.dryRun) {
      smokeArgs.push('--dry-run');
    }
    runNpm(repoRoot, smokeArgs, plan.dryRun);
  }

  if (plan.install) {
    const installArgs = plan.link ? ['-Link'] : [];
    runPlatformScript(plan.installScript, installArgs, { repoRoot, dryRun: plan.dryRun });
  }

  printManualBoundary();
  console.log('\nDone.');
}

main().catch((error) => {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
