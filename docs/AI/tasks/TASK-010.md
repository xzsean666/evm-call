# TASK-010: 聚合服务层与统一客户端 Facade

## Objective
构建面向用户的上层门面（`EvmCallClient` / `RpcService`）与 Archive 执行器（包含区块锁定、分叉重组检测、时间戳二分查块以及 SQLite 缓存管理），对外提供极简、一致、高可用的 SDK 入口。

## Scope
- 实现 `EthereumArchiveRpcExecutor`：
  - 调度 Multicall3 批次调用，绑定单次请求在单一健康端点。
  - 区块锁与重组检测：在指定区块执行时，校验调用前后 Block Header 哈希一致性，防止区块重组产生脏读。
  - 验证链上 Multicall3 官方合约部署区块。
  - 纯公共 RPC 时间戳二分定位历史区块高度：`findBlockNumberByTimestamp(targetTimestampSeconds, lowerBoundBlock)`。
  - 快速读取最新区块高度：`findLatestBlockNumber()`。
  - 读取指定历史区块原生代币余额：`getNativeBalanceAtBlock(request)`。
- 实现顶层客户端门面 `EvmCallClient`：
  - 支持配置指定链（Ethereum, Base 等）或自定义链 ID。
  - **默认启用本地文件 SQLite 持久化**（不传配置时自动使用 `./data/evm-call.db` 并递归创建目录），同时支持用户覆盖路径或传入 `:memory:`。
  - 封装核心业务方法：
    - `call(request, options?)`
    - `batch(requests, options?)`
    - `strictBatch(requests, options?)`
    - `multicall(request, options?)`
    - `multicallErc20(request, options?)`
    - `findBlockNumberByTimestamp(timestampSeconds, lowerBoundBlock?)`
    - `findLatestBlockNumber()`
    - `getNativeBalanceAtBlock(address, blockNumber)`
  - 封装缓存管理方法：
    - `cleanExpiredCache()`
    - `pruneCache(filter?)`
    - `clearCache()`
    - `getAllCooldownStates()`
  - 导出全库入口 `src/index.ts`。
- 编写门面接口与归档执行器的单元测试。

## Allowed Files
- `src/multicall/EthereumArchiveRpcExecutor.ts`
- `src/client/EvmCallClient.ts`
- `src/index.ts`
- `tests/unit/evm-call-client.test.ts`
- `tests/unit/ethereum-archive-rpc-executor.test.ts`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/tasks/TASK-010.md`

## Dependencies
- TASK-006 (SQLite 统一存储与多层级 RPC 缓存服务)
- TASK-007 (内置节点列表与 RPC 节点池管理器)
- TASK-008 (JSON-RPC 批量调用执行器)
- TASK-009 (Multicall3 纯 ABI 编解码与 ERC-20 只读解析器)

## Inputs and Outputs
- **Inputs**: 客户端配置选项（链 ID、自定义 RPC URLs、SQLite 配置、超时设置）。
- **Outputs**: 具备完整 RPC 调用、Multicall、分层缓存与状态持久化能力的统一客户端实例。

## Acceptance Criteria
- 接口风格现代简洁，Promise 友好。
- 缓存命中时跳过网络直接返回，`cacheTtlMs: 0` 时强制刷新。
- 当发生链重组时能自动截获并汇报 `RPC_BLOCK_REORG_DETECTED`。
- `cleanExpiredCache` 能正确清理并返回清理条数。
- `src/index.ts` 导出完整的公共类型与函数。
- 单元测试全面通过。

## Verification Commands
- `pnpm test tests/unit/evm-call-client.test.ts`
- `pnpm test tests/unit/ethereum-archive-rpc-executor.test.ts`
- `pnpm typecheck`

## Risks and Assumptions
- 保持外部公开 API 命名语义明确，避免暴露内部不必要的细节类。

## Status
DONE
