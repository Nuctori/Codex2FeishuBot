# Codex ↔ Feishu Troubleshooting

## Bridge Won't Start

Symptoms: `start bridge` fails or the daemon exits immediately.

Steps:

1. Run `doctor`
2. Check Node.js: `node --version`
3. Check Codex: `codex --version`
4. Verify the legacy data-path config exists: `~/.claude-to-im/config.env`
5. Check logs: `logs 200`

Common causes:

- missing or invalid `config.env`
- Node.js older than 20
- Codex CLI missing or not authenticated
- stale build output; run `npm install && npm run build`

## Feishu Messages Not Received

Symptoms: the Feishu bot is visible but does not respond.

Steps:

1. Run `doctor`
2. Confirm the Feishu app version is published and approved
3. Confirm long-connection event `im.message.receive_v1` is configured
4. Confirm callback `card.action.trigger` is configured
5. Check `CTI_FEISHU_ALLOWED_USERS` if allowlists are enabled
6. Check `logs 200` for incoming Feishu events

## Permission Card Problems

Symptoms: permission cards do not update, buttons do nothing, or approvals time out.

Steps:

1. Confirm `cardkit:card:write` and `cardkit:card:read` scopes are enabled
2. Confirm `im:message:update` is enabled
3. Confirm `card.action.trigger` is configured
4. Publish and approve a new Feishu app version after any permission or callback change
5. Restart with `stop bridge` then `start bridge`

## High Memory Usage

Symptoms: the daemon process consumes increasing memory over time.

Steps:

1. Check `bridge status`
2. Review active sessions from the Feishu control card
3. Archive stale sessions
4. Restart with `stop bridge` then `start bridge`

## Stale PID File

Symptoms: status says running but the process is gone, or startup refuses because a daemon is already recorded.

The daemon management script usually cleans stale PID files automatically. If needed:

```bash
rm ~/.claude-to-im/runtime/bridge.pid
```

Then run `start bridge` again.

## Compatibility Note

Troubleshooting for non-Feishu channels or non-Codex runtimes is intentionally excluded from this maintained-path guide.
