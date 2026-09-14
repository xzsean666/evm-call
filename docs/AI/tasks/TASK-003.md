# TASK-003: 核心数据模型与统一错误层

## Objective
建立 `evm-call` 的核心领域类型、请求与响应模型，以及统一的强类型异常错误层次体系。

## Scope
- 定义统一异常类 `EvmCallError`（包含标准错误码 `ARCHIVE_RPC_UNAVAILABLE`, `RPC_BLOCK_NOT_FOUND`, `RPC_BLOCK_REORG_DETECTED`, `RPC_RESPONSE_INVALID`, `INVALID_REQUEST`, `UNSUPPORTED_CHAIN`, `MULTICALL_NOT_DEPLOYED_AT_BLOCK` 等，明确 `retryable` 属性）。
- 定义通用 JSON-RPC 2.0 请求/响应模型与 Zod 校验 Schema（`JsonRpcRequest`, `JsonRpcBatchItemResult`, `NormalizedJsonRpcRequest`）。
- 定义 Multicall3 领域模型（`MulticallAtBlockRequest`, `MulticallAtBlockResult`, `MulticallAtBlockCall`）。
- 编写对应的单元测试，覆盖 Schema 解析与异常分类判定。

## Allowed Files
- `src/domain/errors.ts`
- `src/domain/jsonRpcModels.ts`
- `src/domain/multicallModels.ts`
- `src/domain/index.ts`
- `tests/unit/errors.test.ts`
- `tests/unit/json-rpc-models.test.ts`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/tasks/TASK-003.md`

## Dependencies
- TASK-002 (项目骨架与工程构建配置)

## Inputs and Outputs
- **Inputs**: 原始领域模型与 Zod 规则。
- **Outputs**: 纯净、强类型的 domain 模块与完整单测。

## Acceptance Criteria
- 错误模型能够准确标识 `retryable: boolean`。
- 请求模型能够自动处理默认值（例如未指定 id 时自动分配，params 为空时自动规范化为空数组）。
- 单元测试全部通过。

## Verification Commands
- `pnpm test tests/unit/errors.test.ts`
- `pnpm test tests/unit/json-rpc-models.test.ts`
- `pnpm typecheck`

## Risks and Assumptions
- 避免引入非 RPC 领域的冗余错误码（如 CEX/DeFi 错误）。

## Status
DONE
