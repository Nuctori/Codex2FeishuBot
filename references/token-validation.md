# Codex ↔ Feishu Token Validation

Validate the Feishu app credentials before starting the bridge.

```bash
curl -s -X POST "${DOMAIN:-https://open.feishu.cn}/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d '{"app_id":"...","app_secret":"..."}'
```

Expected result:

```json
{"code":0}
```

If validation fails, verify:

1. App ID and App Secret belong to the same Feishu app
2. The app has been published and approved
3. The configured domain matches the deployment

Compatibility note: validation flows for non-Feishu channels are intentionally omitted from this maintained-path guide.
