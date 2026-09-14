# TASK-004: 传输层与 JSON-RPC 协议驱动

## Objective
实现标准 Direct HTTPS 传输驱动，负责单次与批量 JSON-RPC 2.0 的 HTTP 发送、信封结构解析、超时控制以及节点级报错映射。

## Scope
- 定义 `HttpTransport` 抽象接口与基础实现（如基于 Axios 或 Fetch 的直连传输）。
- 实现 `ArchiveRpcTransport`：
  - `call(options)`：发送单一 JSON-RPC 请求，解析 `result`，捕获节点 `error` 并封装为 `JsonRpcCallError`。
  - `batchCall(options)`：发送 JSON-RPC 批量数组载荷，支持乱序对齐匹配。
- 确保 Direct-only 约束（禁止引入任何代理中间件配置）。
- 编写 Mock HTTP 传输的单元测试。

## Allowed Files
- `src/transport/HttpTransport.ts`
- `src/transport/AxiosHttpTransport.ts`
- `src/transport/ArchiveRpcTransport.ts`
- `src/transport/index.ts`
- `tests/unit/archive-rpc-transport.test.ts`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/tasks/TASK-004.md`

## Dependencies
- TASK-003 (核心数据模型与统一错误层)

## Inputs and Outputs
- **Inputs**: HTTP 客户端配置、JSON-RPC 请求参数。
- **Outputs**: 强类型的调用结果或节点级结构化错误。

## Acceptance Criteria
- `batchCall` 遇到节点返回非数组响应时能够安全解析（如节点整体验签失败）。
- 具备完善的超时超时与 AbortSignal 中断支持。
- 单元测试覆盖 HTTP 4xx/5xx、超时、Malformed JSON、标准 JSON-RPC error 等各种边缘场景。

## Verification Commands
- `pnpm test tests/unit/archive-rpc-transport.test.ts`
- `pnpm typecheck`

## Risks and Assumptions
- 严格禁止在错误日志或异常中泄露带有敏感 Token 的 URL。

## Status
DONE
