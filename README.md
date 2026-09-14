# evm-call

> 高可用、极简轻量级 EVM RPC 基座 SDK (Node.js & TypeScript)

`evm-call` 是从大型 EVM 数据框架中萃取出的核心 RPC 基础设施。它专注于为业务微服务提供最纯粹、最可靠的底层 RPC 与合约聚合读取能力，杜绝重型 Web3 全家桶依赖，天然具备多节点负载均衡、阶梯式故障避退、大请求自动切片以及区块重组防护。

---

## 核心特性 (Key Features)

- ⚡ **轻量零沉重依赖与原生极速**: 绝不捆绑庞大的 ethers/viem，Multicall3 与 ERC-20 采用纯 TS + BigInt + 原生 Buffer 高效编解码（50x 极速解码），打包极小。
- 🔄 **RPC Pool 节点池与负载均衡**: 内置高质量公共节点（Ethereum / Base），支持无缝注入自定义/私有 RPC 端点，通过无偏随机洗牌实现请求分流。
- 🛡️ **阶梯式冷却避退 (Stepped Backoff Cooldown)**: 节点故障自动触发阶梯式冷静期（1m ~ 24h），业务调用成功时毫秒级自动复原（Fast Recovery）。
- 💾 **SQLite 统一存储与智能分层缓存**:
  - **默认本地持久化文件 (`node:sqlite`)**: 默认路径 `./data/evm-call.db`（绝非临时 memory 模式），无需配置开箱即享真正的跨进程持久化；`:memory:` 仅在测试时显式启用。
  - **L1 In-Memory + L2 SQLite 双层极速架构**: 常用热点数据毫秒级直接由内存直出，支持嵌套事务与安全 BigInt 序列化。
  - **最新易变态 10s 缓存**: 10 秒内重复访问同一最新状态直接命中本地缓存，杜绝高频轮询打爆节点或触发 429 限流。
  - **历史归档不可变长效缓存**: 针对确定性历史区块与哈希（`eth_call`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getBlockByHash` 等），支持长效持久化缓存（默认 30 天），兼具时限控制与单次调用自由穿透覆盖（`cacheTtlMs: 0`）。
  - **过期清理与状态落盘**: 支持 `cleanExpiredCache()` 主动清理过期记录，全池节点冷却画像跨进程重启无缝恢复。
- 📦 **JSON-RPC Batch Call 增强执行器**:
  - **缓存优先调度**: 先查本地 SQLite 缓存，未命中项自动组装 Batch 请求。
  - **全量 Archive 历史归档支持**: 原生分发历史 `eth_call`, `eth_getBalance`, `eth_getStorageAt` 等。
  - **自动切片 (Chunking)**: 默认每 100 条切片，规避节点单个 batch payload 大小限制。
  - **有界并发 (Bounded Concurrency)**: 跨节点分散并发（默认并发 3），防止单点频控。
  - **故障转移 (Failover)**: 遇到节点网络故障、批量响应丢失或配额耗尽时，自动切换健康端点无缝重试。
  - **乱序与类型自适应重排对齐**: 跨字符串与数字 ID 兼容，严格按请求 ID 还原调用方数组顺序。
- 🏛️ **纯公共 Archive RPC 内插时间戳二分查块 (Interpolation Search)**:
  - 采用数学收敛证明的内插二分搜索（$O(\log\log N)$），平均仅需 **3~5 次网络往返** 即可精确定位任意历史时间戳对应的区块高度（较传统二分法降低 80% 网络往返），彻底告别对中心化第三方浏览器 API 的依赖。
- 🧱 **Multicall3 确定性聚合调用**:
  - 支持锁定历史区块执行 `aggregate3`，多批次聚合时自动合并为单次 JSON-RPC 批量，大幅降低往返延迟并收窄重组窗口。
  - 前置/后置区块哈希一致性断言（防链上重组与分叉脏读，截获 `RPC_BLOCK_REORG_DETECTED`）。
  - 内置常用 ERC-20 只读方法便捷封装（`balanceOf`, `allowance`, `decimals`, `name`, `symbol`, `totalSupply`），兼容标准 dynamic string 与 legacy `bytes32`。
- 📜 **生产级事件日志查询 (getLogs & Chunked Streaming)**:
  - **纯粹解耦**: 不绑架 ABI decode 解码，不侵入数据库存储，返回纯净强类型 `EvmLog`。
  - **大跨度自动切片 (`getLogsChunked`)**: 将数万区块范围按指定窗口切片并发抓取，兼具有界并发与实时进度回调。
  - **自适应对半切分 (Adaptive Chunking)**: 遇节点 `query returned more than 10000 results` 或区块跨度过大报错时，自动对半拆分并平滑重试，不冲击受限端点。
  - **流式迭代器 (`iterateLogs`)**: 异步生成器（AsyncGenerator），按区块先后顺序逐步 yield chunk，内存零堆积。
  - **确定性严格排序**: 无论并发乱序如何，结果严格按 `(blockNumber, transactionIndex, logIndex)` 升序呈现。
- 🚫 **无多余业务累赘**: 彻底剔除代理、重型外置数据库、DeFi 兑换计算等无关上层业务。

---

## 安装 (Installation)

```bash
pnpm add evm-call
# 或使用 npm / yarn
npm install evm-call
```

> **运行环境要求**: Node.js >= 22 (推荐 Node.js v24+，基于原生内置 `node:sqlite`)。

---

## 快速上手 (Quick Start)

### 1. 基础客户端初始化

```typescript
import { createEvmCallClient } from "evm-call";

// 零配置开箱即用：内置 Ethereum 主网高可用公共节点，自动在 ./data/evm-call.db 持久化
const client = createEvmCallClient({
  chainId: "ethereum", // 支持 "ethereum", "base" 或任意 chainId 数字
  customRpcUrls: [
    "https://eth-mainnet.g.alchemy.com/v2/YOUR-KEY", // 可选：注入私有高优 RPC
  ],
});
```

### 2. 高性能批量 JSON-RPC 调用 (自动切片与分层缓存)

```typescript
// 批量请求自动查缓存、未命中项切片并发送、乱序响应按 ID 严格恢复次序
const results = await client.batch([
  { id: "block", method: "eth_blockNumber" },
  { id: "gas", method: "eth_gasPrice" },
  { id: "vitalik", method: "eth_getBalance", params: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"] },
]);

for (const item of results) {
  if (item.success) {
    console.log(item.id, item.result);
  }
}

// 严格批量模式：任意单项失败直接抛出异常
const [blockNumber, chainId] = await client.strictBatch<string>([
  { id: 1, method: "eth_blockNumber" },
  { id: 2, method: "eth_chainId" },
]);
```

### 3. Multicall3 批量读取 ERC-20 代币与原生余额 (单次网络往返)

```typescript
// 1. 批量读取 ERC-20 代币元数据与余额
const result = await client.multicallErc20({
  chain: "ethereum",
  // blockNumber 省略时自动解析最新区块高度
  calls: [
    { id: "usdc-sym", tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", method: "symbol" },
    { id: "usdc-dec", tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", method: "decimals" },
    {
      id: "usdc-bal",
      tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      method: "balanceOf",
      owner: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    },
  ],
});

for (const call of result.results) {
  console.log(`${call.id}: ${call.value}`);
}

// 2. 单次 Multicall 批量获取上百个地址的原生币余额 (ETH / BNB / MATIC)
const balances = await client.getNativeBalances({
  chain: "ethereum",
  addresses: [
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "0x0000000000000000000000000000000000000000",
  ],
});
for (const bal of balances.results) {
  console.log(bal.address, bal.amount, "wei");
}
```

### 4. 常用高频链上操作便捷封装 (全量负载均衡与自动 Batch 调度)

针对 EVM 开发中最常面临的“查多个 Hash、查多个区块、查全块回执、批量读 Nonce/Code/Storage”场景，SDK 提供了一行代码调用的极简封装，底层全部自动享受 **RPC 池负载均衡分流、大数组切片 (Chunking)、失败重试与健康节点 Failover**：

```typescript
// 1. 批量查询多个区块 (单次 RPC Batch 网络往返，严格保序)
const blocks = await client.getBlocks([18000000n, 18000001n, "latest"]);

// 2. 批量查询多个交易详情与回执 (传入上百个 txHash 也能自动切片并发调度)
const txs = await client.getTransactions(["0xaaa...", "0xbbb..."]);
const receipts = await client.getTransactionReceipts(["0xaaa...", "0xbbb..."]);

// 3. 1 次网络往返同时查询交易详情与交易回执 (减少一半网络开销)
const { transaction, receipt } = await client.getTransactionWithReceipt("0xaaa...");

// 4. 一键获取区块内的全部交易回执 (现代 L2 原生 eth_getBlockReceipts，传统节点自动降级批量抓取)
const allBlockReceipts = await client.getBlockReceipts(18000000n);

// 5. 批量查询账户 Nonce 与检测合约代码 (快速筛选 EOA vs 智能合约)
const nonces = await client.getTransactionCounts(["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "0xa0b8..."]);
const codes = await client.getCodes(["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "0xa0b8..."]);
const isContract = codes[0] !== "0x";

// 6. 合约底层存储槽 (Storage Slot) 单个或批量读取
const slotValue = await client.getStorageAt("0xa0b8...", 0);
const slots = await client.getStorageAts([
  { address: "0xa0b8...", position: 0 },
  { address: "0xa0b8...", position: 1 },
]);

// 7. Gas 估算与 EIP-1559 历史基础费率
const estimatedGas = await client.estimateGas({
  to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  value: 1000000000000000n,
});
const feeHistory = await client.getFeeHistory(5, "latest", [25, 50, 75]);
const gasPrice = await client.getGasPrice();
```

### 5. 生产级事件日志查询 (单次查询、大跨度切片与流式迭代器)

`evm-call` 对 `eth_getLogs` 提供轻量且坚固的实现：**不包揽 ABI decode、不强制绑定本地存储**，专注交付最可靠的原始日志流。

```typescript
const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// 1. 标准单次查询（参数规范化，严格按 blockNumber, transactionIndex, logIndex 确定性排序）
const logs = await client.getLogs({
  address: USDT_ADDRESS,
  topics: [TRANSFER_TOPIC],
  fromBlock: 18_000_000n,
  toBlock: 18_001_000n,
});

// 2. 大区块跨度全量收集 (自动按 maxBlockRange 切片并发抓取，节点返回 10,000 条超限报错时自适应对半拆细重试)
const allLogs = await client.getLogsChunked(
  {
    address: USDT_ADDRESS,
    topics: [TRANSFER_TOPIC],
    fromBlock: 18_000_000n,
    toBlock: 18_050_000n, // 跨越 50,000 个区块
  },
  {
    maxBlockRange: 2000,    // 单 chunk 默认 2,000 区块
    chunkConcurrency: 3,   // 3 个切片有界并发抓取
    adaptiveChunking: true,// 自动对抗 10,000 结果上限
    onChunkProgress: ({ fromBlock, toBlock, totalLogsSoFar }) => {
      console.log(`Synced blocks ${fromBlock}..${toBlock}, total: ${totalLogsSoFar}`);
    },
  },
);

// 3. 流式遍历消费 (异步迭代器，按区块次序逐步 yield chunk，内存零堆积，适合索引流水线)
for await (const chunk of client.iterateLogs(
  {
    address: USDT_ADDRESS,
    fromBlock: 18_000_000n,
    toBlock: 18_010_000n,
  },
  { maxBlockRange: 1000 },
)) {
  for (const log of chunk) {
    // 强类型 EvmLog: address, topics, data, blockNumber (bigint), logIndex, transactionHash...
    processLog(log);
  }
}
```

### 6. 纯公共 RPC 时间戳二分定位区块

```typescript
// 寻找 2024-01-01 00:00:00 UTC (timestamp: 1704067200) 对应的区块高度
const { blockNumber, rpcEndpointId } = await client.findBlockNumberByTimestamp(
  1704067200,
  18000000, // 可选：起始搜索下界区块
);
console.log(`Block at timestamp: ${blockNumber} (via ${rpcEndpointId})`);
```

### 7. 缓存维护与生命周期管理

```typescript
// 主动清理本地 SQLite 中已过期的短效/长效缓存条数
const cleanedCount = client.cleanExpiredCache();
console.log(`Cleaned ${cleanedCount} expired items.`);

// 定向清理指定时间以前的旧缓存（例如 24 小时前）
client.pruneCache({ olderThanMs: 24 * 60 * 60 * 1000 });

// 查看当前池中健康的 RPC 端点快照
const healthyEndpoints = client.getHealthyEndpoints();

// 进程退出时释放连接
client.close();
```

---

## 客户端配置参数 (Options)

| 参数 | 类型 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- |
| `chainId` | `number \| string` | `1` | 目标链 ID 或链名（`"ethereum"`, `"base"`） |
| `customRpcUrls` | `string[]` | `[]` | 用户自定义私有 RPC 端点列表 |
| `storagePath` | `string` | `"./data/evm-call.db"` | SQLite 本地落盘路径（测试可传 `":memory:"`） |
| `defaultBatchChunkSize`| `number` | `100` | JSON-RPC 批量单包最大切片大小 |
| `defaultMaxConcurrency`| `number` | `3` | 跨切片有界最大并发数 |
| `attemptTimeoutMs` | `number` | `10000` | 单次 RPC 请求超时时间（毫秒） |
| `totalTimeoutMs` | `number` | `30000` | 批量任务全局硬超时时间（毫秒） |
| `maxRpcAttempts` | `number` | `5` | 单切片最大故障轮换重试端点数 |

---

## 运行示例 (Examples)

```bash
# 批量 JSON-RPC 演示
pnpm exec tsx examples/batch-json-rpc.ts

# 分层缓存演示
pnpm exec tsx examples/sqlite-cache-demo.ts

# Multicall3 批量读取代币
pnpm exec tsx examples/multicall-erc20.ts

# 事件日志检索与大跨度流式迭代演示
pnpm exec tsx examples/get-logs-demo.ts

# 批量查交易、区块、回执与账户状态演示
pnpm exec tsx examples/remote-apis-demo.ts

# 自定义 RPC 节点注入与健康探活
pnpm exec tsx examples/custom-rpc-pool.ts
```

---

## 验证与测试 (Testing)

```bash
# 运行全部单元测试与 E2E 测试 (100% 通过)
pnpm test

# 严格类型检查
pnpm typecheck

# 构建生产发布包 (输出 ESM / CJS / .d.ts)
pnpm build
```

---

## 文档与事实来源 (Documentation)

- [项目规范与代理守则 (AGENTS.md)](AGENTS.md)
- [项目总体目标与范围定义 (GOAL.md)](docs/AI/GOAL.md)
- [系统架构蓝图与时序设计 (ARCHITECTURE.md)](docs/AI/ARCHITECTURE.md)
- [架构技术决策记录 (DECISIONS.md)](docs/AI/DECISIONS.md)
- [任务拆分索引与执行进度 (TASK_INDEX.md)](docs/AI/TASK_INDEX.md)
- [当前会话恢复状态 (SESSION_STATE.md)](docs/AI/SESSION_STATE.md)
- [开发代理初始指令集 (AI_AGENT_PROMPT.md)](docs/AI_AGENT_PROMPT.md)

---

## 许可证 (License)

MIT
