# Usage Guide

This project is currently documented and maintained as a `Codex ↔ Feishu` bridge. The legacy command name remains `claude-to-im`.

## setup

Configure the bridge:

```text
claude-to-im setup
```

The maintained setup flow focuses on:

1. **Feishu credentials** — App ID, App Secret, optional domain
2. **Allowed users** — optional restriction for who can reach the bridge
3. **Working directory** — default workspace for Codex sessions
4. **Model and mode** — runtime defaults

## start

Start the bridge daemon in the background:

```text
start bridge
```

If startup fails, run `doctor`.

## stop

Stop the running bridge daemon:

```text
stop bridge
```

## status

Show whether the daemon is running and basic health information:

```text
bridge status
```

## logs

Show recent log output:

```text
logs
logs 200
```

Logs live under `~/.claude-to-im/logs/` and are redacted.

## reconfigure

Update the existing configuration:

```text
reconfigure
```

After changing values, restart the bridge.

## doctor

Run diagnostics:

```text
doctor
```

The maintained checks prioritize:

- Codex runtime availability
- bridge config validity
- Feishu credentials and callback-related readiness
- daemon process health

## Compatibility Notes

The repository still contains compatibility support for other channels and runtimes. Unless a task explicitly asks for them, keep usage guidance centered on the Codex + Feishu path.
