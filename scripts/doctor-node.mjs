#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from './config-env.mjs';

const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
const CONFIG_FILE = path.join(CTI_HOME, 'config.env');
const PID_FILE = path.join(CTI_HOME, 'runtime', 'bridge.pid');
const LOG_FILE = path.join(CTI_HOME, 'logs', 'bridge.log');
const ERROR_LOG_FILE = path.join(CTI_HOME, 'logs', 'bridge-error.log');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const envEntries = loadEnvFile(CONFIG_FILE);

let pass = 0;
let fail = 0;

function check(label, ok) {
  if (ok) {
    console.log(`[OK]   ${label}`);
    pass += 1;
  } else {
    console.log(`[FAIL] ${label}`);
    fail += 1;
  }
}

function getConfig(key) {
  return envEntries.get(key);
}

function readCommandOutput(command, args) {
  try {
    return execFileSync(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
  }
}

function commandExists(command) {
  try {
    execFileSync(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (error) {
    return Boolean(error.stdout || error.stderr);
  }
}

function walkTsFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function listNewerTsFiles(bundlePath, excludedBaseNames = []) {
  if (!fs.existsSync(bundlePath)) return ['<missing bundle>'];

  const excluded = new Set(excludedBaseNames);
  const bundleTime = fs.statSync(bundlePath).mtimeMs;
  const srcFiles = walkTsFiles(path.join(SKILL_DIR, 'src')).filter(
    (filePath) => !excluded.has(path.basename(filePath)),
  );

  return srcFiles.filter((filePath) => fs.statSync(filePath).mtimeMs > bundleTime);
}

function pidAlive(pidText) {
  if (!pidText) return false;
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recentLogHasErrors(logFilePaths) {
  return logFilePaths.some((logFilePath) => {
    if (!fs.existsSync(logFilePath)) return false;
    const lines = fs.readFileSync(logFilePath, 'utf8').trim().split(/\r?\n/).slice(-50);
    return lines.some((line) => /error|fatal/i.test(line) && !/DEP0169|DeprecationWarning/i.test(line));
  });
}

const nodeMajor = Number(process.versions.node.split('.')[0] || '0');
check(`Node.js >= 20 (found v${process.versions.node})`, nodeMajor >= 20);

const runtime = getConfig('CTI_RUNTIME') || 'codex';
const includeCompatibilityDoctor = process.env.CTI_INCLUDE_COMPAT_DOCTOR === 'true';
console.log('Codex ↔ Feishu doctor');
console.log(`Runtime: ${runtime}`);
console.log('');

if (includeCompatibilityDoctor && (runtime === 'claude' || runtime === 'auto')) {
  console.log('Compatibility runtime checks: Claude');
  const hasClaude = commandExists('claude');
  check(
    hasClaude
      ? `Compatibility Claude CLI available (${readCommandOutput('claude', ['--version']) || 'unknown'})`
      : 'Compatibility Claude CLI available (not found in PATH)',
    runtime === 'auto' ? true : hasClaude,
  );

  if (hasClaude) {
    const authStatus = readCommandOutput('claude', ['auth', 'status']);
    const hasThirdPartyAuth = Boolean(getConfig('ANTHROPIC_API_KEY') || getConfig('ANTHROPIC_AUTH_TOKEN'));
    check(
      hasThirdPartyAuth
        ? 'Compatibility Claude CLI auth (skipped — using third-party API credentials from config.env)'
        : 'Compatibility Claude CLI authenticated',
      hasThirdPartyAuth || /loggedIn.*true|logged.in/i.test(authStatus),
    );
  }
}

if (runtime === 'codex' || runtime === 'auto') {
  const configuredCodexExecutable = getConfig('CTI_CODEX_EXECUTABLE') || getConfig('CODEX_EXECUTABLE');
  const hasConfiguredCodexExecutable = Boolean(configuredCodexExecutable && fs.existsSync(configuredCodexExecutable));
  const hasCodexSdk = fs.existsSync(path.join(SKILL_DIR, 'node_modules', '@openai', 'codex-sdk'));
  const hasCodexCli = commandExists('codex');
  const codexAvailabilityOk = hasConfiguredCodexExecutable || hasCodexCli || hasCodexSdk;
  const codexCommand = hasConfiguredCodexExecutable ? configuredCodexExecutable : 'codex';
  check(
    hasConfiguredCodexExecutable
      ? `Codex executable available (${configuredCodexExecutable})`
      : hasCodexCli
        ? `Codex CLI available (${readCommandOutput(codexCommand, ['--version']) || 'unknown'})`
        : hasCodexSdk
          ? 'Codex runtime available via @openai/codex-sdk'
          : 'Codex CLI available (not found in PATH)',
    runtime === 'auto' ? true : codexAvailabilityOk,
  );
  check(
    hasCodexSdk
      ? '@openai/codex-sdk installed'
      : "@openai/codex-sdk installed (not found — run 'npm install' in the skill directory)",
    runtime === 'auto' ? true : hasCodexSdk,
  );

  if (codexAvailabilityOk) {
    const authStatus = hasConfiguredCodexExecutable || hasCodexCli
      ? `${readCommandOutput(codexCommand, ['login', 'status'])}\n${readCommandOutput(codexCommand, ['auth', 'status'])}`
      : '';
    const hasApiKey = Boolean(
      process.env.CTI_CODEX_API_KEY ||
      process.env.CODEX_API_KEY ||
      process.env.OPENAI_API_KEY ||
      getConfig('CTI_CODEX_API_KEY') ||
      getConfig('CODEX_API_KEY') ||
      getConfig('OPENAI_API_KEY'),
    );
    check(
      'Codex auth available (API key or login)',
      hasApiKey || /logged.in|authenticated/i.test(authStatus),
    );
  }
}

const newerDaemonSources = listNewerTsFiles(path.join(SKILL_DIR, 'dist', 'daemon.mjs'), ['windows-watchdog.ts']);
check(
  fs.existsSync(path.join(SKILL_DIR, 'dist', 'daemon.mjs'))
    ? 'dist/daemon.mjs is up to date'
    : "dist/daemon.mjs exists (not built — run 'npm run build')",
  newerDaemonSources.length === 0,
);

const watchdogBundlePath = path.join(SKILL_DIR, 'dist', 'windows-watchdog.mjs');
if (fs.existsSync(watchdogBundlePath)) {
  const newerWatchdogSources = listNewerTsFiles(watchdogBundlePath).filter(
    (filePath) => path.basename(filePath) === 'windows-watchdog.ts',
  );
  check('dist/windows-watchdog.mjs is up to date', newerWatchdogSources.length === 0);
}

check(
  fs.existsSync(CONFIG_FILE) ? 'config.env exists' : `config.env exists (${CONFIG_FILE} not found)`,
  fs.existsSync(CONFIG_FILE),
);

const logDir = path.join(CTI_HOME, 'logs');
try {
  fs.mkdirSync(logDir, { recursive: true });
  fs.accessSync(logDir, fs.constants.W_OK);
  check('Log directory is writable', true);
} catch {
  check(`Log directory is writable (${logDir})`, false);
}

if (fs.existsSync(PID_FILE)) {
  const pidText = fs.readFileSync(PID_FILE, 'utf8').trim();
  check(
    pidAlive(pidText)
      ? `PID file consistent (process ${pidText} is running)`
      : `PID file consistent (stale PID ${pidText}, process not running)`,
    pidAlive(pidText),
  );
} else {
  check('PID file consistency (no PID file, OK)', true);
}

const recentLogsHaveErrors = recentLogHasErrors([LOG_FILE, ERROR_LOG_FILE]);
check(
  recentLogsHaveErrors
    ? 'No recent errors in logs (found ERROR/Fatal lines in bridge.log or bridge-error.log)'
    : 'No recent errors in logs (last 50 lines of bridge.log + bridge-error.log)',
  !recentLogsHaveErrors,
);

console.log('');
console.log(`Results: ${pass} passed, ${fail} failed`);

process.exitCode = fail === 0 ? 0 : 1;
