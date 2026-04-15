# Codex 到飞书

当前产品焦点：把正在进行中的 Codex 编程会话继续带到飞书里。

[English](README.md)

> 兼容说明：当前安装目录名、命令名和遗留数据路径 `~/.claude-to-im/` 暂时保持不变，这样不会打断已有 Codex 工作流；对外产品定位逐步收敛为 `Codex 到飞书`。
>
> 架构说明：仓库中仍保留通用 IM / provider 抽象，但它们现在属于兼容层或预留能力，不是当前主产品承诺。

---

## 这是什么

这个项目会在本机启动一个后台守护进程，把飞书机器人绑定到 Codex 会话。你在飞书里发出的消息会转进 Codex，Codex 的回复会以更适合手机阅读的卡片和文本流式返回。

```text
你（飞书）
  -> 飞书机器人与卡片回调
本地桥接守护进程（Node.js）
  -> Codex CLI / Codex SDK
Codex
  -> 读写你的工作区
```

当前真正维护的路径是 `Codex 到飞书`。仓库里其他内容默认都视为兼容或未来预留空间，除非有明确需求。

## 当前范围

- 当前维护：从飞书继续 Codex 编程会话
- 当前维护：项目列表、会话列表、会话绑定、权限卡片、状态流式更新
- 兼容保留：旧命令名 `claude-to-im`
- 兼容保留：遗留数据路径 `~/.claude-to-im/`
- 兼容保留：仓库中的通用适配层和 provider 抽象
- 不是当前产品承诺：通用多 IM 桥接产品

## 功能特点

- 飞书优先的会话控制：项目列表、会话列表、Open Sessions、卡片内切换
- Codex 原生工作流：飞书消息直接进入真实 Codex 会话，而不是另起一个机器人记忆孤岛
- 移动端友好的权限流：卡片审批，加上 `1 / 2 / 3` 文本回复兜底
- 绑定可持久化：桥接重启后仍能保留会话绑定与镜像
- 对 Windows 友好：PowerShell 安装、watchdog 启动、双日志诊断、服务辅助脚本

## 前置要求

- Node.js >= 20
- Codex CLI：`npm install -g @openai/codex`，然后执行 `codex auth login`，或配置 `OPENAI_API_KEY`
- 飞书应用凭证：自建应用的 App ID 与 App Secret，并开启机器人能力

## 最快开始

先克隆仓库：

```bash
git clone https://github.com/Nuctori/Codex2FeishuBot.git ~/code/Codex2FeishuBot
cd ~/code/Codex2FeishuBot
```

Windows PowerShell：

```powershell
git clone https://github.com/Nuctori/Codex2FeishuBot.git $env:USERPROFILE\code\Codex2FeishuBot
Set-Location $env:USERPROFILE\code\Codex2FeishuBot
```

执行本地 bootstrap：

```bash
npm run bootstrap
```

Windows PowerShell：

```powershell
npm run bootstrap
```

这个命令会自动安装依赖并构建守护进程。若还要顺手安装到 Codex skill 目录：

```bash
npm run bootstrap -- --install
```

Windows PowerShell 开发态软连接安装：

```powershell
npm run bootstrap -- --install --link
```

## 自动化边界

这个仓库现在已经更适合交给别的 AI agent 自动处理，但还不能做到完全无人值守，因为飞书开放平台上的步骤依旧需要人工完成：

- 需要人工创建飞书应用，并拿到 `App ID` / `App Secret`
- 需要人工完成权限审批、机器人能力开启、回调配置、版本发布与管理员审批
- 端到端发消息测试通常还需要人工先提供真实 `chat_id`

一旦仓库、凭证和目标会话信息已经准备好，AI agent 就可以自动完成本地安装、构建、doctor、自检、smoke test 以及 Codex skill 安装。

## 安装

安装到 Codex 后，继续沿用兼容命令名 `claude-to-im`。

完整的从 0 部署和接通检查，请看 `references/zero-deploy-runbook.md`。

### 推荐：bootstrap + install

```bash
npm run bootstrap -- --install
```

Windows PowerShell：

```powershell
npm run bootstrap -- --install
```

### 开发模式：live link 安装

```bash
npm run bootstrap -- --install --link
```

Windows PowerShell：

```powershell
npm run bootstrap -- --install --link
```

### 也可以直接用安装脚本

```bash
bash ./scripts/install-codex.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-codex.ps1
```

### 或直接克隆到 Codex skills 目录

```bash
git clone https://github.com/Nuctori/Codex2FeishuBot.git ~/.codex/skills/claude-to-im
cd ~/.codex/skills/claude-to-im
npm install
npm run build
```

安装脚本会把 skill 放到 `~/.codex/skills/claude-to-im`，安装依赖，并构建守护进程。

安装后对 Codex 说：

```text
claude-to-im setup
```

## 验证安装

打开一个新的 Codex 会话，然后说 `claude-to-im setup`、`start bridge` 或 `bridge status`。

## 更新

如果你是以复制模式安装：

```bash
rm -rf ~/.codex/skills/claude-to-im
npm run bootstrap -- --install
```

Windows PowerShell：

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.codex\skills\claude-to-im
npm run bootstrap -- --install
```

如果你是 `--link` 模式，或者直接克隆在 skill 目录：

```bash
cd ~/.codex/skills/claude-to-im
git pull
npm install
npm run build
```

然后对 Codex 说：

```text
claude-to-im doctor
start bridge
```

## 在 Codex 中快速开始

### 1. 配置

```text
claude-to-im setup
```

当前维护路径的配置流程主要覆盖：

1. 飞书凭证：App ID、App Secret、域名、权限、机器人能力、回调
2. Codex 默认项：工作区、模型、运行模式
3. 启动前校验：配置和连通性检查

### 2. 启动桥接

```text
start bridge
```

守护进程会在后台运行，启动后终端可以关闭。

### 3. 从飞书继续会话

打开飞书，给机器人发消息。Codex 的回复、工具进度和权限提示都会通过桥接返回到飞书。

## Zero-Deploy Smoke Test

完整的人类 + AI 操作者检查清单见 `references/zero-deploy-runbook.md`。

如果你想验证一条“全新安装链路”，又不想污染真实 `~/.codex` skill 目录，可以用它。

只验证本地干净安装 + 构建：

```bash
npm run smoke:deploy
```

验证真实飞书凭证连通性，但不发消息：

```bash
npm run smoke:deploy -- --config ~/.claude-to-im/config.env
```

完整端到端发消息测试：

```bash
npm run smoke:deploy -- --config ~/.claude-to-im/config.env --chat-id <feishu_chat_id>
```

这个脚本会创建一个临时干净 HOME，把当前 checkout 安装进 `.codex/skills/claude-to-im`，执行 `npm ci --ignore-scripts --prefer-offline`、构建守护进程，然后按需继续执行 `doctor` 与飞书 token / bot / 发消息检查。

## 命令

这些命令都是面向 Codex 的；兼容命令名仍然是 `claude-to-im`。

| 命令或自然语言 | 说明 |
|---|---|
| `claude-to-im setup` / `配置桥接` | 配置 Codex 到飞书桥接 |
| `start bridge` / `启动桥接` | 启动后台守护进程 |
| `stop bridge` / `停止桥接` | 停止守护进程 |
| `bridge status` / `查看桥接状态` | 查看当前运行状态 |
| `logs` / `logs 200` / `查看日志` | 查看最近桥接日志 |
| `reconfigure` / `修改配置` | 更新桥接配置 |
| `doctor` / `诊断桥接` | 诊断安装或运行问题 |

## 飞书侧配置清单

`setup` 会提供内联引导。高层步骤包括：

1. 打开 [Feishu Open Platform](https://open.feishu.cn/app) 或 [Lark Open Platform](https://open.larksuite.com/app)
2. 创建一个自建应用，并复制 App ID 与 App Secret
3. 批量添加桥接所需权限
4. 开启机器人能力
5. 配置长连接事件与卡片回调
6. 发布版本并完成管理员审批

如果升级后卡片、权限按钮或回调异常，优先检查权限范围、回调配置和发布状态。

## 遗留运行时数据路径

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

## 核心组件

| 组件 | 作用 |
|---|---|
| `src/main.ts` | 守护进程入口、依赖装配、运行时启动 |
| `src/config.ts` | 读取与持久化桥接配置 |
| `src/store.ts` | 基于 JSON 的桥接状态存储 |
| `src/codex-provider.ts` | Codex 运行时集成 |
| `src/permission-gateway.ts` | 权限请求与审批桥接 |
| `src/logger.ts` | 脱敏滚动日志 |
| `scripts/bootstrap.mjs` | 更适合 AI agent 的一键本地 bootstrap |
| `scripts/daemon.sh` | start / stop / status / logs |
| `scripts/doctor.sh` | 健康诊断 |
| `scripts/smoke-deploy.mjs` | 临时干净安装与可选飞书连通性冒烟 |
| `scripts/feishu-smoke.mjs` | 飞书 token、bot 身份与可选发消息检查 |

## 故障排查

执行：

```text
claude-to-im doctor
```

常见修复方向：

- `~/.claude-to-im/config.env` 缺失时，重新执行 `setup`
- 运行时文件过旧时，执行 `npm install && npm run build`
- 飞书卡片不刷新时，检查权限、回调和发布状态
- 配置修改后，执行 `stop bridge` 再 `start bridge`
