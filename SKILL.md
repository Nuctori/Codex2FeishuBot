---
name: claude-to-im
description: |
  Primary path: bridge THIS Codex session to Feishu so the user can continue coding
  from their phone. Use for: setting up, starting, stopping, or diagnosing the bridge daemon;
  forwarding Codex replies to Feishu; any phrase like "claude-to-im", "bridge", "连上飞书",
  "飞书桥接", "启动桥接", "查看桥接状态", "查看日志", "诊断桥接", "配置桥接".
  The repository still contains broader IM / provider abstractions, but treat them as
  reserved compatibility layers unless the user explicitly asks to work on them.
argument-hint: "setup | start | stop | status | logs [N] | reconfigure | doctor"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# Codex ↔ Feishu

You are managing the `Codex ↔ Feishu` bridge.
User data is stored at the legacy data path `~/.claude-to-im/`.

Treat `Codex ↔ Feishu` as the maintained product path. Other adapters/providers may remain in-tree, but they are compatibility or future-facing layers unless the user explicitly asks to work on them.

The installed skill is usually under `~/.codex/skills/claude-to-im`.
During local development it may instead be a checkout such as `~/code/codex-feishu-bridge`.

## Command parsing

Parse the user's intent from `$ARGUMENTS` into one of these subcommands:

| User says (examples) | Subcommand |
|---|---|
| `setup`, `configure`, `配置`, `配置桥接`, `连上飞书`, `飞书桥接` | setup |
| `start`, `start bridge`, `启动桥接` | start |
| `stop`, `stop bridge`, `停止桥接` | stop |
| `status`, `bridge status`, `查看桥接状态`, `桥接状态` | status |
| `logs`, `logs 200`, `查看日志` | logs |
| `reconfigure`, `修改配置` | reconfigure |
| `doctor`, `diagnose`, `诊断`, `桥接坏了`, `没反应了` | doctor |

Use `status` when the user only wants the current state. Use `doctor` when the user reports a symptom or thinks the bridge is broken.

Extract the optional numeric argument for `logs` and default to 50.

## Runtime detection

Before executing any subcommand, detect which environment you are running in:

1. **Interactive environment** — `AskUserQuestion` is available. You may use a guided setup flow.
2. **Codex / non-interactive environment** — `AskUserQuestion` is not available. Fall back to concise manual guidance, show the relevant config example, and avoid pretending that an interactive wizard exists.

## Config check

Before running any subcommand other than `setup`, check whether `~/.claude-to-im/config.env` exists.

- If it does **not** exist:
  - Tell the user no bridge config was found.
  - Show the minimal Feishu + Codex fields they need to create.
  - Stop there instead of trying to start the daemon.
- If it **does** exist, continue with the requested subcommand.

## Setup

The maintained setup path is Feishu-only.

### Interactive flow

If `AskUserQuestion` is available, collect:

1. **Feishu App ID**
2. **Feishu App Secret**
3. **Feishu domain** (optional)
4. **Allowed user IDs** (optional)
5. **Default workspace**
6. **Model override** (optional)
7. **Bridge mode**

Confirm each value back to the user and mask secrets to the last 4 characters.

Then remind the user to complete the Feishu-side checklist:

1. Add required permissions
2. Enable the bot capability
3. Configure long-connection events and card callbacks
4. Publish the app version and complete admin approval

### Non-interactive flow

If `AskUserQuestion` is unavailable, show the user the relevant fields from `config.env.example` and explain only the Feishu + Codex settings needed for the current product path.

## Subcommands

### `start`

Run `bash "SKILL_DIR/scripts/daemon.sh" start` and report the result.

### `stop`

Run `bash "SKILL_DIR/scripts/daemon.sh" stop`.

### `status`

Run `bash "SKILL_DIR/scripts/daemon.sh" status`.

### `logs`

Run `bash "SKILL_DIR/scripts/daemon.sh" logs N`.

### `reconfigure`

1. Read the current `~/.claude-to-im/config.env`
2. Show a masked summary of the existing values
3. Update only the fields the user wants to change
4. Remind the user to restart the bridge afterward

### `doctor`

Run `bash "SKILL_DIR/scripts/doctor.sh"` and summarize failures with concrete next steps.

Prioritize these root causes:

- missing or invalid `config.env`
- stale build output
- missing Codex CLI or authentication
- missing Feishu scopes / callbacks / publish approval
- stale PID or crashed daemon state

## Notes

- Always mask secrets in output.
- Do not reframe this as a general multi-IM bridge unless the user explicitly asks for that scope.
- When the user asks how to connect Feishu, give the next concrete step rather than dumping the full reference docs unless they ask for detail.
