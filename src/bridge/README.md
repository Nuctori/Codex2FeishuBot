# Codex ↔ Feishu Runtime

This package contains the shared bridge runtime used by the current `Codex ↔ Feishu` product path.

> Compatibility note: the runtime still contains adapter abstractions for other channels. Treat them as compatibility / future-facing layers unless a task explicitly targets them.

## Current Role

The maintained deployment is:

- Feishu receives messages and card actions
- The bridge routes them into Codex sessions
- Tool permissions, session bindings, and message delivery are coordinated in this runtime

## Runtime Responsibilities

- **Session binding** — map Feishu chats and cards to Codex sessions
- **Permission brokering** — coordinate approval requests for tool use
- **Message delivery** — stream status, chunks, and final replies back to Feishu
- **State persistence** — keep bindings, mirrors, and delivery metadata durable
- **Compatibility adapters** — remain available in-tree, but are not the main product contract

## Architecture Notes

The runtime is host-agnostic at the code level, but the product-level maintained path is Feishu-first. The host application supplies persistence, model execution, and lifecycle hooks while this runtime handles routing and delivery concerns.

## Key Host Interfaces

| Interface | Purpose |
|---|---|
| `BridgeStore` | Persistence for sessions, bindings, messages, settings |
| `LLMProvider` | Model execution and streaming |
| `PermissionGateway` | Tool approval resolution |
| `LifecycleHooks` | Startup / shutdown notifications |

## Current Focus

When editing this runtime, optimize first for:

1. Codex session correctness
2. Feishu card / callback correctness
3. Durable session binding and replay safety
4. Mobile-friendly delivery behavior

If you touch other adapters, keep them compatible, but do not let them drive the product narrative.
