# TASK-006: SQLite 统一存储与多层级 RPC 缓存服务

## Objective
实现基于 Node.js 原生 `node:sqlite` 的统一存储适配器（`SqliteStorageAdapter`）与智能分层 RPC 缓存服务（`RpcCacheService`），支持最新态 10 秒短效缓存、历史归档态长效不可变缓存、主动过期清理以及节点冷却状态的落盘持久化。

## Scope
- 实现 `SqliteStorageAdapter`：
  - 基于 `node:sqlite` (`DatabaseSync`)，无第三方 npm 原生扩展依赖。
  - **默认使用本地持久化文件**: 默认路径为 `./data/evm-call.db`（若目录不存在则自动递归 `mkdirSync`），绝非默认 `:memory:` 内存模式；`:memory:` 仅在单元测试或显式配置时作为可选模式。
  - 初始化数据表结构：
    - `evm_cooldown_states` (节点冷却画像表)
    - `evm_rpc_cache` (RPC 调用与 Multicall 缓存表，包含 cache_key, chain_id, method, is_historical, block_tag, result_payload, created_at, expires_at)
  - 建立过期时间索引：`idx_evm_rpc_cache_expires`。
- 实现 `RpcCacheService`：
  - 生成规范化哈希键：`cache_key = sha256(chainId + ":" + method + ":" + canonicalParams)`。
  - 自适应判断是否为历史区块请求（Block Tag 为具象数字/十六进制高度 vs `"latest"`/`"pending"`/未传入）。
  - 分层 TTL 策略：
    - 易变态（Volatile）：默认 10,000ms (10s)。
    - 历史归档态（Historical）：默认 7 天 ~ 30 天（可全局配置与单请求覆盖）。
  - 过期清理：`cleanExpiredCache()`，执行 `DELETE FROM evm_rpc_cache WHERE expires_at <= ?`。
  - 条件清理与清空：`pruneCache(filter?)`、`clearCache()`。
- 实现 `SqliteCooldownStore`：
  - 提供节点冷却画像的读写与恢复接口，与 `CooldownTracker` 对接。
- 编写全面的 SQLite 存储与缓存命中、穿透、过期驱逐单元测试。

## Allowed Files
- `src/storage/SqliteStorageAdapter.ts`
- `src/storage/RpcCacheService.ts`
- `src/storage/SqliteCooldownStore.ts`
- `src/storage/index.ts`
- `tests/unit/sqlite-storage.test.ts`
- `tests/unit/rpc-cache-service.test.ts`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/tasks/TASK-006.md`

## Dependencies
- TASK-003 (核心数据模型与统一错误层)

## Inputs and Outputs
- **Inputs**: 数据库配置（路径、busyTimeoutMs、默认 TTL）、RPC 请求签名与响应结果。
- **Outputs**: 缓存命中读取、缓存写入落盘、过期记录清理统计。

## Acceptance Criteria
- 10 秒内重复读取相同最新态请求，命中缓存直接返回，不走网络。
- 历史区块请求使用长效 TTL，在有效期内稳定命中。
- `cleanExpiredCache()` 可准确清除所有过期项并返回清理数量。
- 节点冷却状态跨客户端重启能够完整恢复。
- 单元测试覆盖率 > 90%。

## Verification Commands
- `pnpm test tests/unit/sqlite-storage.test.ts`
- `pnpm test tests/unit/rpc-cache-service.test.ts`
- `pnpm typecheck`

## Risks and Assumptions
- 运行环境需为支持 `node:sqlite` 的 Node.js 版本（>= 22.5.0），并在未启用时提供优雅降级或内存适配。

## Status
DONE
