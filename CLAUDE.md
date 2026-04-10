# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 构建与运行

```bash
npm run build          # 编译 TypeScript (tsc → dist/)
npm run dev            # 监听模式 — 文件变更自动编译
npm run setup          # 首次绑定微信（扫码）
npm run daemon -- start    # 启动守护进程（launchd/systemd）
npm run daemon -- stop     # 停止守护进程
npm run daemon -- restart  # 代码变更后重启
npm run daemon -- logs     # 查看最近日志
npm run daemon -- status   # 查看运行状态
npm test               # 运行测试 (node --test dist/tests/*.test.js)
```

修改 TypeScript 后务必执行 `npm run build` 验证编译通过。

## 架构

```
微信 (手机) ←→ ilink bot API ←→ Node.js 守护进程 ←→ Claude Code SDK (本地)
```

**消息流**: `monitor.ts` 长轮询微信 API → `main.ts handleMessage()` 路由到命令或 Claude → `provider.ts` 调用 Claude Agent SDK → 结果通过 `send.ts` 流式回传。

### 核心模块

- **`src/main.ts`** — 入口、守护进程生命周期、消息处理、`sendToClaude()` 核心循环。所有状态变更集中在此。
- **`src/claude/provider.ts`** — 封装 `@anthropic-ai/claude-agent-sdk`。处理流式输出（text delta、thinking 预览、tool_use 摘要）、session resume、超时管理。使用全局安装的 `claude` CLI（`pathToClaudeCodeExecutable`）避免 SDK 版本不匹配。
- **`src/commands/router.ts` + `handlers.ts`** — 斜杠命令路由。命令通过 `ctx.updateSession()` 修改会话状态。未知命令通过 `skill-scanner.ts` 匹配已安装的 skill。
- **`src/wechat/monitor.ts`** — 长轮询循环，含指数退避、消息去重（`recentMsgIds` 集合）、会话过期检测（ret: -14）。
- **`src/wechat/api.ts`** — 微信 ilink bot API 的 HTTP 客户端。所有请求为 POST + Bearer token 认证。`sendMessage()` 遇到限频（ret: -2）自动重试。
- **`src/wechat/send.ts`** — 消息发送器，含限频冷却追踪。
- **`src/wechat/media.ts` + `cdn.ts` + `crypto.ts`** — 图片下载管线：CDN URL → AES 解密 → base64 data URI → Claude 图片 block。
- **`src/permission.ts`** — 权限代理：创建带 120s 超时的 pending promise，追踪审批次数，连续 3 次审批后建议切换 `acceptEdits` 模式。
- **`src/session.ts`** — 会话持久化（JSON 文件存于 `~/.wechat-claude-code/sessions/`）。状态机：`idle` → `processing` → `waiting_permission` → `idle`。
- **`src/config.ts`** — 全局配置，存于 `~/.wechat-claude-code/config.env`（key=value 格式，多行用 `\n` 字面量编码）。

### 状态机

会话状态流转：`idle` → `processing`（收到新消息） → `waiting_permission`（工具调用） → `processing`（y/n 后） → `idle`（响应完成）。

启动时，非 `idle` 的残留状态会被强制重置。`/clear` 命令也会拒绝所有待处理权限。

### 并发模型

`monitor.ts` 以 fire-and-forget 方式触发 `onMessage` 回调——轮询循环永远不会被阻塞。当新消息到达时如果 `session.state === 'processing'`，当前查询会通过 `AbortController` 被中断，新消息取而代之。这实现了"中断并重定向"的行为。

## 数据目录

所有运行时数据在 `~/.wechat-claude-code/`：
- `accounts/` — 微信账号凭据（JSON）
- `config.env` — 全局配置（workingDirectory, model, permissionMode, systemPrompt）
- `sessions/` — 每账号会话状态（JSON）
- `logs/` — 按日轮转的日志（`bridge-YYYY-MM-DD.log`），保留 30 天

## 重要模式

- **AbortController 重用问题**：重试失败的 Claude 查询时（如 resume 失败），`AbortController` 可能已被 abort。重试前必须创建新的 controller。
- **SDK session ID 是临时的**：Claude Code 的 session 无法在进程重启后恢复。`sdkSessionId` 被持久化到磁盘后如果守护进程重启，resume 会失败。代码通过"去掉 resume 重试"来处理这种情况。
- **日志自动脱敏**：`logger.ts` 的 `redact()` 函数自动过滤 Bearer token、密码和 API key。
- **微信限频处理**：`api.sendMessage()` 最多重试 3 次，指数退避（10s → 20s → 40s）。`send.ts` 追踪冷却期，在下次发送前等待。
