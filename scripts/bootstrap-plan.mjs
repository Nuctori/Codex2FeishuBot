import path from 'node:path';

export function parseBootstrapArgs(argv) {
  const plan = {
    install: false,
    link: false,
    smoke: false,
    doctor: false,
    skipDeps: false,
    skipBuild: false,
    dryRun: false,
    keep: false,
    configFile: '',
    chatId: '',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      plan.help = true;
    } else if (arg === '--install') {
      plan.install = true;
    } else if (arg === '--link') {
      plan.link = true;
      plan.install = true;
    } else if (arg === '--smoke') {
      plan.smoke = true;
    } else if (arg === '--doctor') {
      plan.doctor = true;
    } else if (arg === '--skip-deps') {
      plan.skipDeps = true;
    } else if (arg === '--skip-build') {
      plan.skipBuild = true;
    } else if (arg === '--dry-run') {
      plan.dryRun = true;
    } else if (arg === '--keep') {
      plan.keep = true;
    } else if (arg === '--config') {
      plan.configFile = argv[++index] || '';
      if (!plan.configFile) {
        throw new Error('--config requires a value');
      }
      plan.smoke = true;
    } else if (arg === '--chat-id') {
      plan.chatId = argv[++index] || '';
      if (!plan.chatId) {
        throw new Error('--chat-id requires a value');
      }
      plan.smoke = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (plan.chatId && !plan.configFile) {
    throw new Error('--chat-id requires --config so smoke can authenticate');
  }

  return plan;
}

export function resolveBootstrapPlan({
  repoRoot,
  platform = process.platform,
  argv = [],
}) {
  if (!repoRoot) {
    throw new Error('repoRoot is required');
  }

  const parsed = parseBootstrapArgs(argv);
  const resolvedRepoRoot = path.resolve(repoRoot);

  return {
    ...parsed,
    repoRoot: resolvedRepoRoot,
    packageLockPath: path.join(resolvedRepoRoot, 'package-lock.json'),
    bootstrapScript: path.join(resolvedRepoRoot, 'scripts', 'bootstrap.mjs'),
    installScript: path.join(
      resolvedRepoRoot,
      'scripts',
      platform === 'win32' ? 'install-codex.ps1' : 'install-codex.sh',
    ),
    doctorScript: path.join(
      resolvedRepoRoot,
      'scripts',
      platform === 'win32' ? 'doctor.ps1' : 'doctor.sh',
    ),
  };
}
