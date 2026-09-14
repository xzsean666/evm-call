# TASK-007: 内置节点列表与 RPC 节点池管理器

## Objective
实现内置的高质量公共 RPC 节点预设（Ethereum 主网、Base 主网），以及统一的 `RpcPool` 节点池管理器，负责多端点并发探针、健康筛选、负载均衡快照、空池自愈，并与 SQLite 冷却画像持久化对接。

## Scope
- 整理并提供内置公共 RPC 节点列表：
  - `BUILTIN_ETHEREUM_RPCS` (drpc, blastapi, mevblocker, nodies, tenderly 等)。
  - `BUILTIN_BASE_RPCS` (base-org, blastapi, drpc, meowrpc, 1rpc 等)。
- 实现 `RpcPool`：
  - 支持传入自定义端点数组，支持追加内置端点或完全自定义替换。
  - `initialize()`：使用受控并发（`maxConcurrentProbes`）探测所有端点（`eth_chainId`, `eth_getBlockByNumber` 块头有效性，可选历史块 18,000,000 探针保证 Archive 深度）。
  - `healthySnapshot()`：过滤冷却端点并使用 `RandomSource` 返回无偏乱序列表。
  - `reportOutcome(id, outcome)`：向对应端点的 `CooldownTracker` 上报业务请求成功/失败，并同步更新 SQLite 持久化存储。
  - `refreshIfNeeded()`：全池节点均不可用时，在冷却防抖后自动触发重新探活。
  - 支持 `onCooldownChange` 事件监听与 SQLite 历史冷却状态恢复。
- 编写单元测试（包含模拟节点探测、探活失败剔除、空池恢复、SQLite 状态恢复等场景）。

## Allowed Files
- `src/pool/builtinEthereumRpcs.ts`
- `src/pool/builtinBaseRpcs.ts`
- `src/pool/RpcPool.ts`
- `src/pool/index.ts`
- `tests/unit/rpc-pool.test.ts`
- `tests/unit/builtin-rpcs.test.ts`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/tasks/TASK-007.md`

## Dependencies
- TASK-004 (传输层与 JSON-RPC 协议驱动)
- TASK-005 (冷却追踪器与时间随机源)
- TASK-006 (SQLite 统一存储与多层级 RPC 缓存服务)

## Inputs and Outputs
- **Inputs**: 端点配置、Transport 实例、SQLite 存储适配器、可注入的 Clock/Random。
- **Outputs**: 高可用健康端点快照、状态监控与持久化。

## Acceptance Criteria
- 探测失败的节点自动标记为不健康，不影响其他节点正常上线。
- `healthySnapshot` 绝不包含处于冷却期或探针失败的端点。
- 支持从 SQLite 自动恢复历史避退状态，避免重启后反复冲击已知故障节点。
- 单测全面通过。

## Verification Commands
- `pnpm test tests/unit/rpc-pool.test.ts`
- `pnpm test tests/unit/builtin-rpcs.test.ts`
- `pnpm typecheck`

## Risks and Assumptions
- 探针不可因为单点报错抛出未捕获异常中止全局初始化。

## Status
DONE
