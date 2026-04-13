# Codex <-> Feishu

当前产品定位: 把正在运行的 Codex 编程会话继续到飞书里。

[English](README.md)

> 兼容说明: 当前安装目录名、命令名和遗留数据路径 `~/.claude-to-im/` 仍然保留, 这样不会打断现有 Codex 工作流。对外产品命名收敛为 `Codex <-> Feishu`。
>
> 架构说明: 仓库里仍保留通用适配层和 provider 抽象, 但现在它们只是兼容或预留能力, 不是当前产品承诺。

## 这是什么

这个项目会在本机启动一个后台守护进程, 把飞书机器人绑定到 Codex 会话。你在飞书里发的消息会转进 Codex, Codex 的回复、工具进度、权限请求和会话导航会回到飞书卡片里。

```text
你(飞书)
  -> 飞书机器人与卡片回调
本地桥接守护进程(Node.js)
  -> Codex CLI / Codex SDK
Codex
  -> 读写你的工作区
```

当前真正维护的路径只有 `Codex <-> Feishu`。

## 当前范围

- 当前维护: 从飞书继续 Codex 编程会话
- 当前维护: 项目列表、会话列表、会话绑定、权限卡片、状态更新
- 兼容保留: 旧命令名 `claude-to-im`
- 兼容保留: 遗留数据路径 `~/.claude-to-im/`
- 兼容保留: 仓库中的通用适配层和 provider 抽象
- 不是当前产品承诺: 通用多 IM 桥接产品

## 功能特点

- 飞书优先的会话控制: 项目列表、会话列表、Open Sessions、卡片内切换
- Codex 原生工作流: 飞书消息直接转进真实 Codex 会话
- 移动端友好的权限流: 卡片审批和 `1 / 2 / 3` 快捷回复兜底
- 绑定可持久化: 桥接重启后仍能保留会话绑定与镜像
- 偏 Windows 的运维支持: PowerShell 安装、watchdog 启动、双日志诊断

## 前置要求

- Node.js >= 20
- Codex CLI: `npm install -g @openai/codex`, 然后执行 `codex auth login`, 或设置 `OPENAI_API_KEY`
- 飞书应用凭证: 自建应用的 App ID 与 App Secret, 并开启机器人能力

## 安装

安装到 Codex 中, 继续使用兼容命令名 `claude-to-im`。

### 推荐: 用 Codex 安装脚本

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/code/codex-feishu-bridge
bash ~/code/codex-feishu-bridge/scripts/install-codex.sh
```

Windows PowerShell:

```powershell
git clone https://github.com/op7418/Claude-to-IM-skill.git $env:USERPROFILE\code\codex-feishu-bridge
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\code\codex-feishu-bridge\scripts\install-codex.ps1
```

本地开发可使用软链接模式:

```bash
bash ~/code/codex-feishu-bridge/scripts/install-codex.sh --link
```

Windows PowerShell 开发安装:

```powershell
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\code\codex-feishu-bridge\scripts\install-codex.ps1 -Link
```

安装脚本会把 skill 放到 `~/.codex/skills/claude-to-im`, 同时安装依赖并构建守护进程。

安装完成后, 对 Codex 说:

```text
claude-to-im setup
```

## 验证安装

开启新的 Codex 会话, 然后说 `claude-to-im setup`、`start bridge` 或 `bridge status`。

## 更新

复制模式安装:

```bash
rm -rf ~/.codex/skills/claude-to-im
bash ~/code/codex-feishu-bridge/scripts/install-codex.sh
```

Windows PowerShell:

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.codex\skills\claude-to-im
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\code\codex-feishu-bridge\scripts\install-codex.ps1
```

软链接或直接克隆安装:

```bash
cd ~/.codex/skills/claude-to-im
git pull
npm install
npm run build
```

然后对 Codex 说:

```text
claude-to-im doctor
start bridge
```

## 快速开始

### 1. 配置

```text
claude-to-im setup
```

当前维护路径的配置流程只覆盖:

1. 飞书凭证: App ID、App Secret、域名、权限、机器人能力、回调
2. Codex 默认值: 工作区、模型、运行模式
3. 启动前校验: 配置与连通性检查

### 2. 启动桥接

```text
start bridge
```

守护进程会在后台运行, 终端可以关闭。

### 3. 从飞书继续会话

打开飞书给机器人发消息, Codex 的回复、工具进度与权限请求都会通过桥接回到飞书。

## 命令

这些命令都是面向 Codex 的; 兼容命令名仍然是 `claude-to-im`。

| 命令或自然语言 | 说明 |
|---|---|
| `claude-to-im setup` / `配置桥接` | 配置 Codex <-> Feishu 桥接 |
| `start bridge` / `启动桥接` | 启动后台守护进程 |
| `stop bridge` / `停止桥接` | 停止守护进程 |
| `bridge status` / `查看桥接状态` | 查看当前运行状态 |
| `logs` / `logs 200` / `查看日志` | 查看最近桥接日志 |
| `reconfigure` / `修改配置` | 更新桥接配置 |
| `doctor` / `诊断桥接` | 诊断安装或运行问题 |

## 飞书配置清单

`setup` 会内联引导, 整体上需要完成:

1. 进入 https://open.feishu.cn/app
2. 创建自建应用并复制 App ID 与 App Secret
3. 批量添加桥接所需权限
4. 开启机器人能力
5. 配置长连接事件与卡片回调
6. 发布版本并完成管理员审批

如果升级后卡片、权限按钮或回调异常, 优先检查权限范围、回调配置和发布状态。

## 遗留运行时数据路径

```text
~/.claude-to-im/   # 为兼容保留的遗留数据路径
├── config.env
├── data/
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   └── messages/
├── logs/
│   └── bridge.log
└── runtime/
    ├── bridge.pid
    └── status.json
```

## 核心组件

| 组件 | 作用 |
|---|---|
| `src/main.ts` | 守护进程入口与运行时装配 |
| `src/config.ts` | 读取与持久化桥接配置 |
| `src/store.ts` | 基于 JSON 的桥接状态存储 |
| `src/codex-provider.ts` | Codex 运行时集成 |
| `src/permission-gateway.ts` | 权限请求和审批桥接 |
| `src/logger.ts` | 脱敏日志与轮转 |
| `scripts/daemon.sh` | start / stop / status / logs |
| `scripts/doctor.sh` | 健康诊断 |

## 故障排查

执行:

```text
claude-to-im doctor
```

常见修复方向:

- `~/.claude-to-im/config.env` 缺失时重新执行 `setup`
- 运行时文件过旧时执行 `npm install && npm run build`
- 飞书卡片不刷新时检查权限、回调和发布状态
- 配置改动后执行 `stop bridge` 再 `start bridge`
