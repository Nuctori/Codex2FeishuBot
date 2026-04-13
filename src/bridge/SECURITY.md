# Codex ↔ Feishu Runtime Security

This document describes the security posture of the shared bridge runtime used by the maintained `Codex ↔ Feishu` deployment.

## Threat Model

Key threats for the maintained path:

1. **Unauthorized Feishu access** — an unexpected sender attempts to reach Codex through the bot
2. **Prompt injection** — hostile content is forwarded from chat into the coding session
3. **Command or path abuse** — user-controlled inputs try to influence workdir or shell behavior
4. **Permission spoofing** — forged or duplicated card actions attempt to approve tool use
5. **Message flooding** — repeated requests try to degrade responsiveness or exhaust resources

## Mitigations

### Authorization

- Feishu requests are validated against binding and allowlist rules
- Card actions are tied back to the original pending permission context
- Unknown or unauthorized senders are ignored without leaking extra state

### Input Validation

- Working directory validation rejects traversal and suspicious shell characters
- Session identifiers are validated before lookup or mutation
- Dangerous inputs are sanitized or blocked before entering the runtime

### Permission Safety

- Callback origin is validated against the original chat / card context
- Pending permission records are claimed atomically to prevent double approval
- Short-window dedup prevents repeated forwards of the same permission prompt

### Auditability

- Inbound and outbound bridge events are logged through the host store
- Dangerous or truncated inputs are marked explicitly
- Secret-bearing values are redacted before display

## Deployment Guidance

1. Prefer explicit Feishu allowlists
2. Rotate app secrets through the Feishu Open Platform
3. Re-verify callbacks and scopes after bridge upgrades
4. Keep the bridge running as a normal user process, not an elevated service
