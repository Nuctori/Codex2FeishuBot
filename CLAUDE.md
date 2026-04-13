# CLAUDE.md — Project Guidelines for Codex ↔ Feishu

## Replying to GitHub Issues

When replying to user-reported issues, always include a short **self-help prompt** at the end of the reply. Guide users to use Codex to diagnose and fix the problem themselves.

Example:

> **自助排查提示：** 你可以直接在 Codex 里发送下面这段话，让它先帮你诊断：
> ```
> 请帮我排查 Codex ↔ Feishu 的问题：
> 1. 读取 ~/.claude-to-im/logs/bridge.log 最近 50 行
> 2. 读取 ~/.claude-to-im/config.env 检查桥接配置
> 3. 运行 ~/.codex/skills/claude-to-im/scripts/doctor.sh 并分析输出
> 4. 根据日志、配置和诊断结果给出具体修复建议
> ```

This approach:

- Reduces maintainer burden by enabling users to self-diagnose
- Leverages the fact that users already have Codex installed
- Provides actionable next steps instead of only explaining the error
