# Project Goal: evm-call

## 1. 项目定位 (Positioning)
`evm-call` 是从大型 EVM 数据索引框架 (`EVM-Data-SDK`) 中萃取出的**高可用、高可靠、极简轻量级的 EVM RPC 基座 SDK**。

现代许多业务和微服务只需要向 EVM 节点发送批量 JSON-RPC 或执行 Multicall3 聚合调用，并不需要庞大的 DeFi 算法、预言机映射、数据库同步或代理基础设施。`evm-call` 的目标就是为这些场景提供一个零沉重依赖、具备自动负载均衡、故障熔断避退、请求自动切片分流的纯净底层基座。

---

## 2. 提取的核心功能 (In-Scope Core Features)

### 2.1 RPC Pool 节点池管理 (Pool Management)
- **多端点生命周期管理**: 支持注册多个 RPC 节点端点（具备唯一 `id`、`url`、可选的认证标识）。
- **主动探针健康检查 (Active Probes)**:
  - 启动阶段/按需探测节点可用性 (`initialize`)。
  - 严格校验节点连通性与一致性：`eth_chainId` 验证目标链，`eth_getBlockByNumber` 检查块头结构，可选历史块 Multicall 深度检查。
  - 支持并发上限保护 (`maxConcurrentProbes`)，防止节点探活被打爆。
- **空池自愈机制 (`refreshIfNeeded`)**: 当池中所有节点因故障全部不可用时，在冷却时间过后支持自动触发重试探活。
- **状态恢复与持久化对接**: 支持导出节点状态与恢复已有的惩罚状态 (`restoreCooldownState`, `getAllCooldownStates`)。

### 2.2 节点池负载均衡 (Load Balancing)
- **健康节点打乱与轮换**: 提供基于 Fisher-Yates 洗牌算法的无偏随机排列（`shuffle`），从当前未处于冷却期的健康节点中动态生成快照（`healthySnapshot`）。
- **请求分片负载均衡**: 跨批次或分片（chunk）执行时，随机均衡分散请求流量，避免单点限流。

### 2.3 阶梯式惩罚冷却 (Stepped Backoff Cooldown / CD)
- **多级惩罚阶梯 (Cooldown Tiers)**:
  - 节点请求失败时自动触发递增避退惩罚（默认阶梯：1m -> 5m -> 15m -> 30m -> 1h -> 2h -> 4h -> 8h -> 12h -> 24h）。
  - 避免频繁冲击已知出现异常或限流的端点。
- **快速恢复 (Fast Recovery)**:
  - 节点在真实业务请求成功后，立即清除失败计数与冷却状态，恢复为完全健康节点。
- **状态事件通知**: 支持节点进入/离开冷却时的事件回调钩子 (`onCooldownChange`)。

### 2.4 内置 Pool 与自定义 RPC 注入 (Built-in Pools & Custom Injection)
- **内置公共 RPC 预设**:
  - 内置高质量公开 Ethereum 主网 RPC 列表。
  - 内置高质量公开 Base 主网 RPC 列表。
- **灵活的外部注入**:
  - 允许调用方传入自己的专用或私有 RPC URL（如 Alchemy, Infura, QuickNode, 自建全节点/归档节点）。
  - 支持模式：追加内置节点、完全覆盖为纯自定义节点、或按链 ID 初始化。

### 2.5 JSON-RPC Batch Call 与 Archive 归档调用支持 (JSON-RPC Batch & Archive RPC)
- **标准 JSON-RPC 2.0 批量请求**: 符合 `[ { jsonrpc: "2.0", id: 1, ... }, ... ]` 规范。
- **全量 Archive 历史归档调用支持**:
  - 底层节点池经过归档深度探测（例如以太坊主网 18,000,000 块探针），原生支持通过 Batch Call 执行任意历史区块（Archive Block Tag）的调用：
    - 历史合约状态调用：`eth_call` (带历史 blockNumber)
    - 历史账户原生余额批量读取：`eth_getBalance` (带历史 blockNumber)
    - 历史合约存储插槽批量查询：`eth_getStorageAt`
    - 历史区块头与交易批量拉取：`eth_getBlockByNumber`, `eth_getTransactionReceipt`
    - 历史事件过滤查询：`eth_getLogs`
- **基于纯 Archive RPC 的时间戳二分查块 (`findBlockNumberByTimestamp`)**:
  - 纯公共 Archive RPC 实现，无需任何第三方浏览器 API Key 或中心化服务，通过二分法向归档节点查询 `eth_getBlockByNumber` 块头时间戳，快速定位任意历史时间戳对应的区块高度。
  - 最新区块头快捷读取：`findLatestBlockNumber`。
  - 历史原生代币余额安全读取：`getNativeBalanceAtBlock`（附带调用前后 Block Hash 校验防重组）。
- **大请求自动分片 (Automatic Chunking)**: 针对大批量请求数组，按预设大小（例如 100）切片，避免超出节点的单次 batch payload 大小限制。
- **有界并发执行 (Bounded Concurrency)**: 分片在节点池中受控并发请求（例如并发度 3），实现高吞吐且防止触发并发限流。
- **故障自动重试与节点漂移 (Failover)**: 单个节点发生网络中断或节点级报错时，自动无缝切换到健康池中的下一节点重试。
- **请求-响应乱序对齐 (Out-of-order Reconciliation)**: 根据 request `id` 精准重排与对齐响应，保证返回结果顺序与入参严格一致。
- **双模态结果处理**:
  - **宽松模式 (`executeBatch`)**: 返回区分成功/失败的联合类型 (`JsonRpcBatchItemResult`)，允许部分请求成功、部分失败（方便业务做逐条错误分析）。
  - **严格模式 (`executeStrictBatch`)**: 一旦存在任何一条 JSON-RPC 错误，立即抛出异常。
  - **单调用便捷方法 (`call`)**: 复用池化与故障转移能力的快捷单一请求。

### 2.6 Multicall3 聚合调用 (Multicall3 Support)
- **零外部依赖纯 TypeScript ABI 编解码**:
  - 无需引入庞大的 ethers.js 或 viem。
  - 内置纯 TS/BigInt 实现的 Multicall3 `aggregate3((address,bool,bytes)[])` 编解码器（`encodeAggregate3`, `decodeAggregate3Result`）。
- **指定区块调用与重组防护 (Block Reorganization Protection)**:
  - 支持在指定历史区块或最新区块上执行 Multicall3。
  - 在调用前后校验区块哈希（Pre/Post Block Hash Assertion），检测到区块重组时主动丢弃并报警或重试。
  - 校验目标区块是否晚于 Multicall3 合约部署高度。
- **高频 ERC-20 快捷读取**:
  - 内置 `balanceOf`, `allowance`, `decimals`, `name`, `symbol`, `totalSupply` 等常用只读方法的纯 TS 编解码器。
  - 极大简化批量代币余额、元数据读取场景。

### 2.7 SQLite 统一存储与智能分层 RPC 缓存 (SQLite Storage & Tiered Cache)
- **零额外依赖的 Node 原生 SQLite (`node:sqlite`)**:
  - 无需任何外部 npm 原生 C++ 编译扩展，直接利用 Node.js 原生 SQLite 引擎。
  - **默认持久化文件存储**: **默认模式绝非 `:memory:` 内存模式**，而是默认落盘到本地持久化文件（默认路径 `./data/evm-call.db`，父级目录自动递归创建）。
  - 开箱即具备真正的跨进程、跨任务持久化能力；`:memory:` 仅作为显式配置的可选模式（用于单元测试或只读容器）。
- **节点冷却状态本地持久化 (`evm_cooldown_states`)**:
  - 自动将全池节点的连续失败计数、避退阶梯、冷却截止时间持久化到 SQLite 中。
  - 跨进程重启、定时任务（Cron）或多实例运行能够无缝恢复节点健康画像，避免重启丢失避退状态。
- **智能分层 RPC 缓存机制 (`evm_rpc_cache`)**:
  - **最新易变态 / 短效缓存 (Volatile Cache)**:
    - 针对未指定历史区块、或指定 `"latest"` / 当前最新高度的请求（如高频轮询最新余额、gasPrice、最新块高等）。
    - **默认 10 秒缓存**（10s 内重复访问直接读取 SQLite 缓存命中，彻底防爆端点限流）。
  - **历史归档态 / 长效不可变缓存 (Immutable Archive Cache)**:
    - 针对明确指定历史区块（十六进制或数字 Block Number）的 RPC 调用（如 `eth_call`, `eth_getBalance`, `eth_getStorageAt`, `multicallAtBlock` 等）。
    - 历史区块数据具有链上不可变性（Immutable），支持长期持久化缓存（默认可配置，如 7 天、30 天或自定义时长）。
  - **灵活的单次调用覆盖**:
    - 支持调用方在单次请求中按需指定 `cacheTtlMs`（例如自定义缓存秒数，或传 `0` 强制跳过缓存穿透请求 RPC）。
- **过期缓存主动清理与维护 (Cache Pruning & Eviction)**:
  - **主动过期清理 (`cleanExpiredCache`)**: 执行 `DELETE FROM evm_rpc_cache WHERE expires_at <= ?`，并返回清理的记录条数。
  - **条件清理 (`pruneCache`)**: 支持按链 ID、时间范围、历史/最新类型定向清理。
  - **全量清空 (`clearCache`)**: 提供单表或全局缓存清空能力。

---

## 3. 明确剔除的非目标功能 (Non-Goals / Out-of-Scope)
为了保持基座纯粹极简，以下 `EVM-Data-SDK` 中的重度业务功能一律**不提取、不迁移**：
1. **剔除 SingBox 代理与代理池管理**: 仅保留 Direct HTTPS 纯直连通信。
2. **剔除 PostgreSQL 关系型数据库与复杂数据同步**: 纯 SDK 库设计，不捆绑任何重量级外部数据库驱动（仅使用 Node 原生轻量 SQLite 进行本地冷却和 RPC 缓存维护）。
3. **剔除 DeFi 协议深度计算**: 不包含 Uniswap v3/v4 tick/sqrtPrice 数学、Swap 路由报价等协议特异逻辑。
4. **剔除 Chainlink 预言机数据库与喂价服务**: 不包含特定喂价地址字典、轮次解码等。
5. **剔除 CEX 行情同步**: 不包含 Binance、Gate 等中心化交易所 Kline/深度同步逻辑。
6. **剔除重型 Web3 运行时库**: 保持依赖项最小化（仅使用 axios/fetch、zod），打包体积维持在极小量级。
