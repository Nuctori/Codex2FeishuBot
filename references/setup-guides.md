# Codex ↔ Feishu Setup Guide

This guide documents the maintained setup path only: Codex sessions continued from Feishu.

## Feishu App ID and App Secret

1. Go to https://open.feishu.cn/app
2. Create or open your self-built app
3. Open **Credentials & Basic Info**
4. Copy **App ID** and **App Secret**

## Phase 1: Permissions and Bot Capability

Complete this phase and publish before configuring callbacks.

### Batch-add Required Permissions

1. Open **Permissions & Scopes**
2. Use batch configuration if available
3. Add the required scopes:

```json
{
  "scopes": {
    "tenant": [
      "im:message:send_as_bot",
      "im:message:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:update",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:chat:read",
      "im:resource",
      "cardkit:card:write",
      "cardkit:card:read"
    ],
    "user": []
  }
}
```

### Enable Bot

1. Open **Add Features**
2. Enable **Bot**
3. Set the bot name and description

### Publish First Version

1. Open **Version Management & Release**
2. Create a version
3. Submit for review
4. Approve it in Feishu Admin Console

The bot will not work until the version is approved and published.

## Phase 2: Events and Card Callback

The bridge must be running before saving event subscriptions because Feishu validates the long connection.

1. In Codex, run `start bridge`
2. In Feishu Open Platform, open **Events & Callbacks**
3. Set event dispatch method to **Long Connection**
4. Add event `im.message.receive_v1`
5. Add callback `card.action.trigger`
6. Save the configuration
7. Publish a new app version and approve it

## Upgrade Checklist

If an existing Feishu app stops receiving messages, updating cards, or handling permission buttons:

1. Re-check all scopes above
2. Re-check `card.action.trigger`
3. Run `start bridge` before saving callback changes
4. Publish and approve a new version
5. Restart with `stop bridge` then `start bridge`

## Optional Domain

Default:

```text
https://open.feishu.cn
```

Set `CTI_FEISHU_DOMAIN` only if your deployment requires a different Feishu-compatible endpoint.

## Allowed User IDs

Use `CTI_FEISHU_ALLOWED_USERS` to restrict who can reach Codex through the bridge.

Values should be Feishu `open_id` identifiers such as:

```text
ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Compatibility Note

This file intentionally does not include Telegram, Discord, QQ, Weixin, or alternate provider setup flows. Those code paths may remain for compatibility work, but they are not the current product setup path.
