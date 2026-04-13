# Security

These notes describe the maintained `Codex ↔ Feishu` deployment path for this project.

## Credential Storage

Bridge credentials are stored in the legacy data path `~/.claude-to-im/config.env` with file mode `600` when created by the setup flow. This file should stay local and must never be committed.

Stored secrets may include:

- Feishu App ID
- Feishu App Secret
- Optional allowlist identifiers
- Local runtime preferences for the Codex bridge

## Log Redaction

All secrets are masked in terminal output and bridge logs. Only the last 4 characters are shown. This rule applies to:

- setup confirmation
- reconfigure output
- doctor output
- log inspection
- runtime error messages

## Threat Model

This project is a local single-user bridge:

- The daemon runs under the local user account
- The bridge connects outbound to Feishu and Codex-related services
- The maintained path does not require opening a public inbound HTTP server
- Message access is controlled by Feishu app permissions and local binding rules

Primary threats:

- **Credential leakage** — mitigated by local-only storage, file permissions, masking, and `.gitignore`
- **Unauthorized Feishu users** — mitigated by allowlists, session binding checks, and card-action validation
- **Privilege misuse on the local machine** — mitigated by running as a normal user process instead of an elevated service
- **Stale or misconfigured callbacks** — mitigated by explicit doctor/setup guidance and publish-state verification

## Token Rotation

If a Feishu app secret is compromised or expired:

1. Revoke or rotate the secret in Feishu Open Platform
2. Run `claude-to-im reconfigure`
3. Restart the bridge with `stop bridge` and `start bridge`
4. Re-check logs and callback behavior

## Leak Response

If you suspect credentials leaked:

1. Revoke them immediately in Feishu Open Platform
2. Stop the bridge
3. Update the stored credentials
4. Review `~/.claude-to-im/logs/` for suspicious activity
5. Restart only after the new credentials and callbacks are verified
