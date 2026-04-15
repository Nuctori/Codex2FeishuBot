# Codex to Feishu

Primary product focus: continue live Codex coding sessions from Feishu.

[中文文档](README_CN.md)

> Compatibility note: the installed skill name, command, and legacy data path `~/.claude-to-im/` remain unchanged for now, so existing Codex workflows keep working while the product branding moves toward `Codex to Feishu`.
>
> Architecture note: broader IM and provider abstractions still exist in-tree, but they are compatibility or future-facing layers rather than the current product promise.

---

## What This Project Is

This project runs a local background daemon that binds a Feishu bot to Codex sessions. Messages from Feishu are forwarded into Codex, and Codex responses are pushed back as mobile-friendly cards and text updates.

```text
You (Feishu)
  -> Feishu bot + card callbacks
Local bridge daemon (Node.js)
  -> Codex CLI / Codex SDK
Codex
  -> reads and writes your workspace
```

The maintained path is `Codex to Feishu`. Anything else in the repository should be treated as reserved implementation space unless explicitly requested.

## Product Scope

- Maintained now: Codex session continuation from Feishu
- Maintained now: project/session browsing, session binding, permission cards, streaming/status updates
- Compatibility only: legacy install path `claude-to-im`
- Compatibility only: generic adapter/provider abstractions still in-tree
- Not the current product promise: general-purpose multi-IM bridge positioning

## Features

- Feishu-first session control: project list, session list, open-session dock, and in-card session switching
- Codex-native workflow: forwards Feishu messages into live Codex sessions instead of creating a separate bot-only memory silo
- Permission flow for mobile: card approvals plus quick `1 / 2 / 3` reply fallback
- Persistent bindings: session bindings and mirrors survive bridge restarts
- Windows-friendly operations: PowerShell install, watchdog startup, dual-log diagnostics, service helpers

## Prerequisites

- Node.js >= 20
- Codex CLI: install with `npm install -g @openai/codex`, then authenticate with `codex auth login` or `OPENAI_API_KEY`
- Feishu app credentials: App ID + App Secret for a self-built app with bot capability enabled

## Quickest Start

Clone this repository:

```bash
git clone https://github.com/Nuctori/Codex2FeishuBot.git ~/code/Codex2FeishuBot
cd ~/code/Codex2FeishuBot
```

Windows PowerShell:

```powershell
git clone https://github.com/Nuctori/Codex2FeishuBot.git $env:USERPROFILE\code\Codex2FeishuBot
Set-Location $env:USERPROFILE\code\Codex2FeishuBot
```

Run the local bootstrap:

```bash
npm run bootstrap
```

Windows PowerShell:

```powershell
npm run bootstrap
```

That command installs dependencies and builds the daemon. To also install the skill into Codex:

```bash
npm run bootstrap -- --install
```

Windows PowerShell live-link install:

```powershell
npm run bootstrap -- --install --link
```

## Automation Boundary

This repository is now much friendlier to other AI agents, but it still cannot do a perfect zero-human setup because Feishu platform operations remain external:

- A human must create the Feishu app and obtain `App ID` / `App Secret`
- A human must approve scopes, bot capability, callbacks, and version publish
- A human usually needs to provide a real `chat_id` before an end-to-end send test can run

Once the repository checkout and credentials exist, an AI agent can automate local install, build, doctor, smoke tests, and Codex skill installation.

## Installation

Install into Codex and keep using the legacy `claude-to-im` command name for compatibility.

For a full from-zero deployment and connection checklist, use `references/zero-deploy-runbook.md`.

### Recommended: bootstrap + install

```bash
npm run bootstrap -- --install
```

Windows PowerShell:

```powershell
npm run bootstrap -- --install
```

### Development mode: live link install

```bash
npm run bootstrap -- --install --link
```

Windows PowerShell:

```powershell
npm run bootstrap -- --install --link
```

### Alternative: install script directly

```bash
bash ./scripts/install-codex.sh
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-codex.ps1
```

### Alternative: clone directly into Codex skills

```bash
git clone https://github.com/Nuctori/Codex2FeishuBot.git ~/.codex/skills/claude-to-im
cd ~/.codex/skills/claude-to-im
npm install
npm run build
```

The install script places the skill under `~/.codex/skills/claude-to-im`, installs dependencies, and builds the daemon.

After installation, tell Codex:

```text
claude-to-im setup
```

## Verify Installation

Start a new Codex session and say `claude-to-im setup`, `start bridge`, or `bridge status`.

## Updating

If you installed with the Codex install script in copy mode:

```bash
rm -rf ~/.codex/skills/claude-to-im
npm run bootstrap -- --install
```

Windows PowerShell:

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.codex\skills\claude-to-im
npm run bootstrap -- --install
```

If you installed with `--link` or cloned directly into the Codex skills directory:

```bash
cd ~/.codex/skills/claude-to-im
git pull
npm install
npm run build
```

Then tell Codex:

```text
claude-to-im doctor
start bridge
```

## Quick Start in Codex

### 1. Run setup

```text
claude-to-im setup
```

The setup flow for the maintained product path covers:

1. Feishu credentials: App ID, App Secret, domain, permissions, bot capability, callbacks
2. Codex defaults: workspace, model, runtime mode
3. Validation: configuration and connectivity checks before launch

### 2. Start the bridge

```text
start bridge
```

The daemon runs in the background, so your terminal can close after startup.

### 3. Continue the session from Feishu

Open Feishu and send a message to your bot. Codex responses, tool progress, and permission prompts are returned through the bridge.

## Zero-Deploy Smoke Test

Full human + AI operator checklist: `references/zero-deploy-runbook.md`.

Use this when you want to verify a fresh install path without touching your real `~/.codex` skill directory.

Local clean install + build only:

```bash
npm run smoke:deploy
```

Real Feishu credential connectivity, without sending a message:

```bash
npm run smoke:deploy -- --config ~/.claude-to-im/config.env
```

Full end-to-end send test:

```bash
npm run smoke:deploy -- --config ~/.claude-to-im/config.env --chat-id <feishu_chat_id>
```

The smoke script creates a temporary clean HOME, installs this checkout into `.codex/skills/claude-to-im`, runs `npm ci --ignore-scripts --prefer-offline`, builds the daemon, then optionally runs `doctor` plus a Feishu token, bot, and message-send check.

## Commands

All commands are intended for Codex. The legacy command name is still `claude-to-im`.

| Command or phrase | Description |
|---|---|
| `claude-to-im setup` / `配置桥接` | Configure the Codex to Feishu bridge |
| `start bridge` / `启动桥接` | Start the background daemon |
| `stop bridge` / `停止桥接` | Stop the daemon |
| `bridge status` / `查看桥接状态` | Show daemon status |
| `logs` / `logs 200` / `查看日志` | Show recent bridge logs |
| `reconfigure` / `修改配置` | Update bridge configuration |
| `doctor` / `诊断桥接` | Diagnose install or runtime issues |

## Feishu Setup Checklist

The `setup` flow provides inline guidance. At a high level you need:

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) or [Lark Open Platform](https://open.larksuite.com/app)
2. Create a custom app and copy App ID + App Secret
3. Batch-add the permissions required by this bridge
4. Enable the Bot capability
5. Configure long-connection events and card callbacks
6. Publish the app version and complete admin approval

If callbacks or permission cards fail after an upgrade, re-check scopes, callback registrations, and publish status first.

## Legacy Runtime Data Path

```text
~/.claude-to-im/
├─ config.env
├─ data/
│  ├─ sessions.json
│  ├─ bindings.json
│  ├─ permissions.json
│  └─ messages/
├─ logs/
│  └─ bridge.log
└─ runtime/
   ├─ bridge.pid
   └─ status.json
```

## Key Components

| Component | Role |
|---|---|
| `src/main.ts` | Daemon entry, dependency assembly, runtime startup |
| `src/config.ts` | Loads and persists bridge config |
| `src/store.ts` | JSON-backed bridge state storage |
| `src/codex-provider.ts` | Codex runtime integration |
| `src/permission-gateway.ts` | Permission request and approval bridge |
| `src/logger.ts` | Redacted rotating logs |
| `scripts/bootstrap.mjs` | AI-friendly one-command local bootstrap |
| `scripts/daemon.sh` | Start / stop / status / logs |
| `scripts/doctor.sh` | Health diagnostics |
| `scripts/smoke-deploy.mjs` | Clean temporary install and optional Feishu connectivity smoke |
| `scripts/feishu-smoke.mjs` | Feishu token, bot identity, and optional message-send check |

## Troubleshooting

Run:

```text
claude-to-im doctor
```

Common fixes:

- Re-run `setup` if `~/.claude-to-im/config.env` is missing
- Rebuild with `npm install && npm run build` if runtime files are stale
- Re-check Feishu permissions, callbacks, and publish status if cards do not update
- Restart the daemon after config changes with `stop bridge` then `start bridge`
