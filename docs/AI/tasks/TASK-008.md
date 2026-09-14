# TASK-008: JSON-RPC 批量调用执行器（集成缓存与 Archive 支持）

## Objective
实现高性能、容错性强的 `JsonRpcBatchExecutor`，集成 `RpcCacheService` 缓存优先调度，支持大批量通用及 Archive 历史请求的自动切片（Chunking）、有界并发、健康节点轮换、自动故障转移（Failover）与响应乱序对齐。

## Scope
- 实现 `JsonRpcBatchExecutor`：
  - `executeBatch(requests, options)`：
    - 前置缓存查询：优先从 `RpcCacheService` 检索已缓存项，仅将未命中的请求组装成 Batch 发送 RPC。
    - 自动切片（`batchChunkSize` 默认 100），有界并发（`maxConcurrency` 默认 3）。
    - 支持执行任意通用及 Archive 历史归档 JSON-RPC 调用（历史 `eth_call`, `eth_getBalance`, `eth_getStorageAt`, `eth_getBlockByNumber`, `eth_getTransactionReceipt` 等）。
    - 每个切片从 `RpcPool` 获取健康节点快照，按批次或按切片随机负载均衡。
    - 遇到瞬时失败（可重试错误）自动向池上报 `failure` 并切换下一个可用节点重试，直到达到最大尝试次数或总体超时。
    - 请求-响应 ID 对齐恢复：无论节点返回项顺序如何，准确恢复入参次序。
    - 响应结果按策略写回 `RpcCacheService`（最新态 10s，历史态长效）。
  - `executeStrictBatch(requests, options)`：遇到首个调用错误直接抛出异常。
  - `call(request, options)`：单请求便捷包装（同样接入缓存优先逻辑）。
- 编写全面的单元测试，覆盖缓存命中/穿透、切片并发、端点故障漂移重试、乱序对齐以及批量历史 Archive RPC 查询等。

## Allowed Files
- `src/batch/JsonRpcBatchExecutor.ts`
- `src/batch/index.ts`
- `tests/unit/json-rpc-batch-executor.test.ts`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/tasks/TASK-008.md`

## Dependencies
- TASK-004 (传输层与 JSON-RPC 协议驱动)
- TASK-006 (SQLite 统一存储与多层级 RPC 缓存服务)
- TASK-007 (内置节点列表与 RPC 节点池管理器)

## Inputs and Outputs
- **Inputs**: `JsonRpcRequest[]` 列表、执行控制选项（含缓存覆写参数）。
- **Outputs**: 结构化的 `JsonRpcBatchItemResult[]` 或严格解包后的结果数组。

## Acceptance Criteria
- 开启缓存时，部分命中项不发起网络请求，未命中项发起 RPC，最终结果无缝组装对齐。
- 支持处理成百上千条大批量请求，切片并发执行无溢出。
- 首选端点报错时能够平滑 failover 至第二端点完成请求。
- 乱序响应能准确匹配对应 ID，缺失项补全标准错误。
- 单元测试覆盖率 > 90%。

## Verification Commands
- `pnpm test tests/unit/json-rpc-batch-executor.test.ts`
- `pnpm typecheck`

## Risks and Assumptions
- 缓存写入需在响应成功后执行，不可缓存失败的 RPC 错误。

## Status
DONE
