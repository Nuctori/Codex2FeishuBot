# Codex ↔ Feishu 从 0 部署接通测试手册

这份手册面向两类操作者：

- **人类操作者**：按顺序复制命令，完成从 clone、配置到飞书接通验证。

- **AI 操作者**：在无人值守或远程协助时，按检查点执行，不泄漏密钥，不破坏现有 `~/.codex` 与 `~/.claude-to-im`。

当前产品路径只覆盖 **Codex ↔ Feishu**。仓库里保留的通用 IM / provider 抽象属于兼容或预留能力，不作为本手册的部署目标。

## 0. 安全边界

1. 不要把 `CTI_FEISHU_APP_SECRET`、`CTI_CODEX_API_KEY`、`OPENAI_API_KEY` 粘到日志、截图或聊天里。

2. 真实配置文件默认放在遗留数据路径 `~/.claude-to-im/config.env`，不要提交到 git。

3. `npm run smoke:deploy` 默认使用临时干净 HOME，不会写入真实 `~/.codex` skill 目录。

4. 如果显式传入 `--home <path>`，脚本认为这是用户提供的目录，测试结束后不会自动删除。

5. 使用 `--dry-run` 时不会复制配置、安装依赖、构建或调用飞书 API，只验证命令路径和隔离环境。

## 1. 前置要求

### 本机工具

- Node.js >= 20。

- Git。

- Codex CLI：`npm install -g @openai/codex`。

- Codex 已认证：优先 `codex auth login`，或设置 `CTI_CODEX_API_KEY` / `OPENAI_API_KEY`。

- 可访问飞书开放平台与飞书 API。

### Windows 网络代理

如果 Windows 系统代理为 `127.0.0.1:7890` 这类本地代理，`smoke:feishu` 会尽量从系统代理读取并重新执行自身。旧 Node 可能不支持 `NODE_USE_ENV_PROXY`，遇到网络超时时可手动设置：

```powershell
$env:HTTPS_PROXY="http://127.0.0.1:7890"
$env:HTTP_PROXY="http://127.0.0.1:7890"
```

## 2. 获取代码并安装依赖

### Windows PowerShell

```powershell
git clone https://github.com/op7418/codex-feishu-bridge.git $env:USERPROFILE\code\codex-feishu-bridge
Set-Location $env:USERPROFILE\code\codex-feishu-bridge
npm ci
npm run build
```

### macOS / Linux / Git Bash

```bash
git clone https://github.com/op7418/codex-feishu-bridge.git ~/code/codex-feishu-bridge
cd ~/code/codex-feishu-bridge
npm ci
npm run build
```

## 3. 创建飞书自建应用

在 [Feishu Open Platform](https://open.feishu.cn/app) 或 [Lark Open Platform](https://open.larksuite.com/app) 中：

1. 创建或打开自建应用。

2. 在 **凭证与基础信息** 中复制 **App ID** 与 **App Secret**。

3. 开启 **机器人** 能力。

4. 添加并发布所需权限：

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

5. 提交版本并完成管理员审批。

6. 启动桥接后，再配置 **事件与回调**：

   - 事件订阅方式：长连接。

   - 事件：`im.message.receive_v1`。

   - 卡片回调：`card.action.trigger`。

7. 每次修改权限、事件或回调后，都需要重新发布版本并完成审批。

## 4. 写入本机配置

把 `config.env.example` 复制到 `~/.claude-to-im/config.env`，再填入真实值。

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force $env:USERPROFILE\.claude-to-im | Out-Null
Copy-Item .\config.env.example $env:USERPROFILE\.claude-to-im\config.env
notepad $env:USERPROFILE\.claude-to-im\config.env
```

### macOS / Linux / Git Bash

```bash
mkdir -p ~/.claude-to-im
cp config.env.example ~/.claude-to-im/config.env
${EDITOR:-vi} ~/.claude-to-im/config.env
```

最低字段：

```dotenv
CTI_RUNTIME=codex
CTI_ENABLED_CHANNELS=feishu
CTI_DEFAULT_WORKDIR=/path/to/your/project
CTI_DEFAULT_MODE=code
CTI_FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxxx
CTI_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
# CTI_FEISHU_DOMAIN=https://open.feishu.cn
# CTI_FEISHU_ALLOWED_USERS=ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## 5. 不碰真实环境的部署冒烟

先验证“从当前 checkout 安装到干净 HOME 并构建”：

```bash
npm run smoke:deploy
```

成功标准：

```text
[OK] Local clean install + build passed.
Skip Feishu connection: provide --config <config.env> to test real credentials.
```

如果只是让 AI 确认命令结构，不允许联网或写临时安装目录，可用：

```bash
npm run smoke:deploy -- --dry-run
```

## 6. 真实飞书凭证连通性测试

只验证 App ID / App Secret、tenant token 与 bot 身份，不发消息：

### Windows PowerShell

```powershell
npm run smoke:feishu -- --config $env:USERPROFILE\.claude-to-im\config.env
```

### macOS / Linux / Git Bash

```bash
npm run smoke:feishu -- --config ~/.claude-to-im/config.env
```

成功标准：

```text
[OK] tenant_access_token acquired
[OK] bot resolved: <bot name>
[OK] Real Feishu credential connectivity verified. Provide --chat-id to send a test message.
```

## 7. 获取 chat_id 并发送端到端测试消息

如果桥接已经接收过该飞书会话消息，可从绑定文件里取 `chatId`。

### Windows PowerShell

```powershell
$bindings = Get-Content $env:USERPROFILE\.claude-to-im\data\bindings.json -Raw | ConvertFrom-Json
$bindings.PSObject.Properties.Value |
  Where-Object { $_.channelType -eq "feishu" } |
  Select-Object -ExpandProperty chatId -Unique
```

### macOS / Linux / Git Bash

```bash
node -e "const fs=require('fs'),os=require('os'),path=require('path');const p=path.join(process.env.CTI_HOME||path.join(os.homedir(),'.claude-to-im'),'data','bindings.json');const data=JSON.parse(fs.readFileSync(p,'utf8'));for (const b of Object.values(data)) if (b.channelType==='feishu') console.log(b.chatId)"
```

然后发送真实测试消息：

### Windows PowerShell

```powershell
npm run smoke:feishu -- --config $env:USERPROFILE\.claude-to-im\config.env --chat-id <feishu_chat_id> --text "Codex ↔ Feishu smoke test OK"
```

### macOS / Linux / Git Bash

```bash
npm run smoke:feishu -- --config ~/.claude-to-im/config.env --chat-id <feishu_chat_id> --text "Codex ↔ Feishu smoke test OK"
```

成功标准：

```text
[OK] message sent: <message_id>
```

如果还没有 `bindings.json`，先把机器人拉入目标会话或直接给机器人发一条消息，再启动桥接接收一次事件；也可以从飞书事件日志中读取该会话的 `chat_id`。

## 8. 一条命令做“干净部署 + 真实飞书接通”

这条命令会创建临时 HOME，把当前 checkout 安装到 `.codex/skills/claude-to-im`，安装依赖、构建、运行 doctor，再用复制到临时 HOME 的配置测试飞书。

### Windows PowerShell

```powershell
npm run smoke:deploy -- --config $env:USERPROFILE\.claude-to-im\config.env --chat-id <feishu_chat_id>
```

### macOS / Linux / Git Bash

```bash
npm run smoke:deploy -- --config ~/.claude-to-im/config.env --chat-id <feishu_chat_id>
```

成功标准：

```text
[OK] Zero-deploy smoke completed.
```

## 9. 安装到 Codex skill

确认冒烟通过后，再安装到真实 Codex skill 目录。

### Windows PowerShell

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-codex.ps1
```

开发时希望直接使用当前 checkout，可改用软链接：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-codex.ps1 -Link
```

### macOS / Linux / Git Bash

```bash
bash ./scripts/install-codex.sh
```

开发软链接：

```bash
bash ./scripts/install-codex.sh --link
```

安装后打开新的 Codex 会话，输入：

```text
claude-to-im setup
start bridge
bridge status
```

## 10. 运行时接通验证

1. 在 Feishu 给机器人发空 `@` 或普通消息。

2. 预期返回控制卡片。

3. 在卡片里选择 workspace、project、session。

4. 再发一条普通消息，预期该消息进入当前绑定的 Codex session。

5. 触发需要权限的操作时，预期飞书返回权限卡片；点击后 Codex 继续执行。

6. 查看日志：

```text
logs 200
```

## 11. AI 操作者一站式流程

AI 在远程协助时按这个顺序执行：

1. `git status --short`，确认没有要保护的未提交变更。

2. `npm ci`，如果依赖已存在且用户只要快速验证，可跳过。

3. `npm run build`。

4. `npm run smoke:deploy`，确认干净安装链路。

5. 如果用户明确提供或本机已存在配置：`npm run smoke:feishu -- --config <config.env>`。

6. 如果能安全取得 `chat_id`：再运行带 `--chat-id` 的发送测试。

7. 如果需要验证完整从 0 部署：`npm run smoke:deploy -- --config <config.env> --chat-id <chat_id>`。

8. 失败时只汇报错误类型和下一步，不打印密钥；配置缺失时停止并提示用户补齐。

## 12. 常见失败判断

| 现象 | 优先检查 |
|---|---|
| `config.env not found` | 是否已复制到 `~/.claude-to-im/config.env`，或 `--config` 路径是否正确 |
| `CTI_FEISHU_APP_ID is missing` | 配置文件字段名是否为 `CTI_FEISHU_APP_ID` |
| `tenant_access_token missing` | App ID / App Secret 是否同属一个飞书应用，应用是否仍有效 |
| 网络超时 | 本机代理、DNS、公司网络、Node 是否支持环境代理 |
| bot 能解析但发消息失败 | `im:message:send_as_bot` 权限、机器人是否在目标会话、`chat_id` 是否正确 |
| 飞书无响应 | 长连接事件 `im.message.receive_v1`、卡片回调 `card.action.trigger`、版本发布与管理员审批 |
| 卡片按钮无响应 | `cardkit:card:write` / `cardkit:card:read` / `im:message:update` 权限与回调发布状态 |
| Codex 执行失败 | `codex auth login`、`OPENAI_API_KEY`、当前 workspace 权限、Codex CLI 版本 |

## 13. 交付前检查清单

- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run smoke:deploy` 通过。
- `npm run smoke:feishu -- --config <config.env>` 通过。
- 如可取得 `chat_id`，带 `--chat-id` 的发送测试通过。
- README 入口、飞书配置清单和本手册保持一致。
