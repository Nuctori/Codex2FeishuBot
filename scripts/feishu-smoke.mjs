#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { loadEnvFile } from './config-env.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/feishu-smoke.mjs --config <config.env> [--chat-id <chat_id>] [--text <message>] [--dry-run]',
    '',
    'Checks:',
    '  1. Read Codex ↔ Feishu config.env',
    '  2. Exchange app_id/app_secret for tenant_access_token',
    '  3. Resolve bot identity via /bot/v3/info/',
    '  4. Optionally send a text message when --chat-id is provided',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    configFile: path.join(process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im'), 'config.env'),
    chatId: '',
    text: `Codex ↔ Feishu smoke test ${new Date().toISOString()}`,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--config') {
      args.configFile = argv[++index] || '';
    } else if (arg === '--chat-id') {
      args.chatId = argv[++index] || '';
    } else if (arg === '--text') {
      args.text = argv[++index] || '';
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function getRequiredConfig(envEntries, key) {
  const value = envEntries.get(key);
  if (!value) {
    throw new Error(`${key} is missing in config.env`);
  }
  return value;
}

function normalizeBaseUrl(domainSetting) {
  const raw = String(domainSetting || '').trim();
  if (!raw || raw.toLowerCase() === 'feishu') {
    return 'https://open.feishu.cn';
  }
  if (raw.toLowerCase() === 'lark') {
    return 'https://open.larksuite.com';
  }
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  }
  if (raw.toLowerCase().includes('larksuite')) {
    return 'https://open.larksuite.com';
  }
  return 'https://open.feishu.cn';
}

function mask(value) {
  if (!value) return '<empty>';
  if (value.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
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

function supportsNodeEnvProxy() {
  const [majorText = '0', minorText = '0'] = process.versions.node.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major >= 25) return true;
  if (major === 24) return minor >= 5;
  if (major === 23) return true;
  if (major === 22) return minor >= 21;
  return false;
}

function maybeReexecWithWindowsProxy() {
  if (process.platform !== 'win32') return;
  if (process.env.FEISHU_SMOKE_PROXY_BOOTSTRAPPED === '1') return;
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) return;

  const proxyEnv = readWindowsInternetProxyEnv();
  if (!proxyEnv.HTTP_PROXY && !proxyEnv.HTTPS_PROXY) return;
  if (!supportsNodeEnvProxy()) {
    console.warn('[warn] Windows system proxy detected, but this Node version may not honor NODE_USE_ENV_PROXY.');
    console.warn('[warn] Set HTTPS_PROXY/HTTP_PROXY manually or use Node 24.5+ / 22.21+ for smoke:feishu.');
    return;
  }

  const result = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...proxyEnv,
      FEISHU_SMOKE_PROXY_BOOTSTRAPPED: '1',
    },
  });
  process.exit(result.status ?? 1);
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response from ${url}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  if (typeof json.code === 'number' && json.code !== 0) {
    throw new Error(`Feishu API error from ${url}: code=${json.code} msg=${json.msg || json.message || ''}`);
  }
  return json;
}

async function runFeishuSmoke({ configFile, chatId, text, dryRun }) {
  const resolvedConfig = path.resolve(configFile);
  if (!fs.existsSync(resolvedConfig)) {
    throw new Error(`config.env not found: ${resolvedConfig}`);
  }

  const envEntries = loadEnvFile(resolvedConfig);
  const appId = getRequiredConfig(envEntries, 'CTI_FEISHU_APP_ID');
  const appSecret = getRequiredConfig(envEntries, 'CTI_FEISHU_APP_SECRET');
  const baseUrl = normalizeBaseUrl(envEntries.get('CTI_FEISHU_DOMAIN'));

  console.log('Codex ↔ Feishu smoke');
  console.log(`Config: ${resolvedConfig}`);
  console.log(`Domain: ${baseUrl}`);
  console.log(`App ID: ${mask(appId)}`);
  console.log(`Send message: ${chatId ? `yes (${chatId})` : 'no (--chat-id not provided)'}`);

  if (dryRun) {
    console.log('[DRY-RUN] Feishu API calls skipped.');
    return;
  }

  const tokenData = await requestJson(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tenantToken = tokenData.tenant_access_token;
  if (!tenantToken) {
    throw new Error('tenant_access_token missing from Feishu response');
  }
  console.log('[OK] tenant_access_token acquired');

  const botData = await requestJson(`${baseUrl}/open-apis/bot/v3/info/`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tenantToken}` },
  });
  const bot = botData.bot || {};
  console.log(`[OK] bot resolved: ${bot.app_name || bot.name || bot.open_id || '<unknown>'}`);

  if (!chatId) {
    console.log('[OK] Real Feishu credential connectivity verified. Provide --chat-id to send a test message.');
    return;
  }

  const sendData = await requestJson(`${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });

  console.log(`[OK] message sent: ${sendData.data?.message_id || '<message_id unavailable>'}`);
}

async function main() {
  maybeReexecWithWindowsProxy();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  await runFeishuSmoke(args);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { normalizeBaseUrl, parseArgs, parseWindowsProxyServer, runFeishuSmoke };
