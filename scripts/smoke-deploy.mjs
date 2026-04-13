#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function usage() {
  return [
    'Usage:',
    '  node scripts/smoke-deploy.mjs [--home <temp-home>] [--config <config.env>] [--chat-id <chat_id>] [--keep] [--dry-run]',
    '',
    'Default behavior:',
    '  - Creates a clean temporary HOME',
    '  - Installs this checkout into .codex/skills/claude-to-im',
    '  - Runs npm ci --ignore-scripts --prefer-offline + npm run build in the installed copy',
    '  - Runs doctor and Feishu connectivity only when --config is provided',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    homeDir: '',
    configFile: '',
    chatId: '',
    keep: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--home') {
      args.homeDir = argv[++index] || '';
    } else if (arg === '--config') {
      args.configFile = argv[++index] || '';
    } else if (arg === '--chat-id') {
      args.chatId = argv[++index] || '';
    } else if (arg === '--keep') {
      args.keep = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function shouldExclude(relativePath) {
  const segments = relativePath.split(/[\\/]/);
  return segments.some((segment) => ['.git', 'node_modules', 'dist', 'coverage'].includes(segment))
    || path.basename(relativePath) === '.DS_Store';
}

function copyTree(sourceDir, targetDir, relativeBase = '') {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const relativePath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
    if (shouldExclude(relativePath)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(sourcePath, targetPath, relativePath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function isSensitiveEnvKey(key) {
  const normalized = key.toUpperCase();
  return normalized.startsWith('CTI_FEISHU_')
    || normalized.startsWith('FEISHU_')
    || normalized.startsWith('LARK_')
    || /(^|_)(TOKEN|SECRET|API_KEY|PASSWORD|PASS)(_|$)/.test(normalized)
    || normalized.includes('AUTH_TOKEN');
}

function listSensitiveEnvKeys(env) {
  return Object.keys(env).filter(isSensitiveEnvKey).sort();
}

function normalizeProxyUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function parseWindowsProxyServer(proxyServer) {
  const raw = String(proxyServer || '').trim();
  if (!raw) return {};
  if (!raw.includes('=')) {
    const proxy = normalizeProxyUrl(raw);
    return proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {};
  }

  const pairs = raw.split(';').map((entry) => entry.trim()).filter(Boolean);
  const proxyMap = new Map();
  for (const pair of pairs) {
    const [scheme, value] = pair.split('=', 2);
    if (!scheme || !value) continue;
    proxyMap.set(scheme.trim().toLowerCase(), normalizeProxyUrl(value));
  }

  const httpProxy = proxyMap.get('http') || proxyMap.get('https') || '';
  const httpsProxy = proxyMap.get('https') || proxyMap.get('http') || '';
  const result = {};
  if (httpProxy) result.HTTP_PROXY = httpProxy;
  if (httpsProxy) result.HTTPS_PROXY = httpsProxy;
  return result;
}

function getSystemRegExePath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'reg.exe');
}

function readWindowsInternetProxyEnv() {
  if (process.platform !== 'win32') return {};
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const regExe = getSystemRegExePath();
    const regEnv = {
      SystemRoot: process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
      WINDIR: process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows',
    };
    const enableOut = spawnSync(regExe, ['query', key, '/v', 'ProxyEnable'], {
      encoding: 'utf8',
      env: regEnv,
      windowsHide: true,
    });
    if ((enableOut.status ?? 1) !== 0 || !/0x1\b/i.test(enableOut.stdout || '')) {
      return {};
    }

    const serverOut = spawnSync(regExe, ['query', key, '/v', 'ProxyServer'], {
      encoding: 'utf8',
      env: regEnv,
      windowsHide: true,
    });
    if ((serverOut.status ?? 1) !== 0) {
      return {};
    }
    const match = (serverOut.stdout || '').match(/ProxyServer\s+REG_\w+\s+(.+)\s*$/m);
    if (!match?.[1]) {
      return {};
    }
    const proxyEnv = parseWindowsProxyServer(match[1]);
    if (!proxyEnv.HTTP_PROXY && !proxyEnv.HTTPS_PROXY) {
      return {};
    }
    return {
      NODE_USE_ENV_PROXY: '1',
      ...proxyEnv,
    };
  } catch {
    return {};
  }
}

function buildSmokeEnv(homeDir, ctiHome) {
  const codexHome = path.join(homeDir, '.codex');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (isSensitiveEnvKey(key)) {
      delete env[key];
    }
  }
  return {
    ...env,
    ...readWindowsInternetProxyEnv(),
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEX_HOME: codexHome,
    CTI_CODEX_HOME: codexHome,
    CTI_CODEX_ISOLATE_HOME: 'true',
    CTI_HOME: ctiHome,
    npm_config_userconfig: path.join(homeDir, '.npmrc'),
    NPM_CONFIG_USERCONFIG: path.join(homeDir, '.npmrc'),
  };
}

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  if (options.dryRun) {
    return;
  }
  const { dryRun: _dryRun, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...spawnOptions,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    run(process.execPath, [npmExecPath, ...args], options);
    return;
  }
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

function copyConfig(configFile, ctiHome) {
  const resolved = path.resolve(configFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`config.env not found: ${resolved}`);
  }
  fs.mkdirSync(ctiHome, { recursive: true });
  const targetConfig = path.join(ctiHome, 'config.env');
  fs.copyFileSync(resolved, targetConfig);
  return targetConfig;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  const ownsHomeDir = !args.homeDir;
  const homeDir = path.resolve(args.homeDir || fs.mkdtempSync(path.join(os.tmpdir(), 'codex-feishu-bridge-smoke-')));
  const skillDir = path.join(homeDir, '.codex', 'skills', 'claude-to-im');
  const ctiHome = path.join(homeDir, '.claude-to-im');

  console.log('Codex ↔ Feishu zero-deploy smoke');
  console.log(`Source: ${repoRoot}`);
  console.log(`Clean HOME: ${homeDir}`);
  console.log(`Install target: ${skillDir}`);

  const smokeEnv = buildSmokeEnv(homeDir, ctiHome);
  console.log(`Isolated CODEX_HOME: ${smokeEnv.CODEX_HOME}`);
  console.log(`Isolated CTI_HOME: ${smokeEnv.CTI_HOME}`);
  const leakedKeys = listSensitiveEnvKeys(smokeEnv);
  console.log(`Sensitive env stripped: ${leakedKeys.length === 0 ? 'yes' : 'no'}`);
  if (leakedKeys.length > 0) {
    throw new Error(`Sensitive environment variables leaked into smoke env: ${leakedKeys.join(', ')}`);
  }

  try {
    if (args.dryRun) {
      console.log('[DRY-RUN] Copy/install/build skipped.');
    } else {
      copyTree(repoRoot, skillDir);
      fs.writeFileSync(path.join(homeDir, '.npmrc'), '');
    }
    runNpm(['ci', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: skillDir, env: smokeEnv, dryRun: args.dryRun });
    runNpm(['run', 'build'], { cwd: skillDir, env: smokeEnv, dryRun: args.dryRun });

    if (!args.configFile) {
      console.log('\n[OK] Local clean install + build passed.');
      console.log('Skip Feishu connection: provide --config <config.env> to test real credentials.');
      return;
    }

    const smokeConfig = args.dryRun
      ? path.join(ctiHome, 'config.env')
      : copyConfig(args.configFile, ctiHome);
    if (args.dryRun) {
      console.log(`[DRY-RUN] Config copy skipped: ${path.resolve(args.configFile)} -> ${smokeConfig}`);
    }
    run(process.execPath, [path.join(skillDir, 'scripts', 'doctor-node.mjs')], {
      cwd: skillDir,
      env: smokeEnv,
      dryRun: args.dryRun,
    });

    const feishuArgs = [path.join(skillDir, 'scripts', 'feishu-smoke.mjs'), '--config', smokeConfig];
    if (args.chatId) feishuArgs.push('--chat-id', args.chatId);
    run(process.execPath, feishuArgs, {
      cwd: skillDir,
      env: smokeEnv,
      dryRun: args.dryRun,
    });

    console.log('\n[OK] Zero-deploy smoke completed.');
  } finally {
    if (args.keep || !ownsHomeDir) {
      console.log(`Kept smoke HOME: ${homeDir}`);
    } else {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
