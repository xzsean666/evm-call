# TASK-009: Multicall3 纯 ABI 编解码与 ERC-20 只读解析器

## Objective
实现零重度依赖的纯 TypeScript Multicall3 ABI 编解码器（`aggregate3`）与常用 ERC-20 只读方法编解码器，实现底层轻量高效的合约批量读取能力。

## Scope
- 实现 `Multicall3Codec`：
  - `MULTICALL3_ADDRESS`（标准确定性部署地址 `0xcA11bde05977b3631167028862bE2a173976CA11`）。
  - `encodeAggregate3(calls)`：将 `(address target, bool allowFailure, bytes callData)[]` 严格编码为 16 进制调用数据。
  - `decodeAggregate3Result(returnData, expectedCount)`：严格按照字对齐解析动态元组切片，提取单项 `success` 和 `returnData`。
  - `MULTICALL3_GET_BLOCK_NUMBER_SELECTOR` 与 `decodeGetBlockNumberResult`（支持区块高度探活）。
- 实现 `Erc20Codec`：
  - 编码与解码：`balanceOf`, `allowance`, `decimals`, `name`, `symbol`, `totalSupply`。
  - 支持 `string`（UTF-8 文本）与 `bytes32`（如早期 MKR 代币）的自适应解析。
- 编写单元测试，使用真实链上数据样本做编解码往返验证。

## Allowed Files
- `src/multicall/Multicall3Codec.ts`
- `src/multicall/Erc20Codec.ts`
- `src/multicall/index.ts`
- `tests/unit/multicall3-codec.test.ts`
- `tests/unit/erc20-codec.test.ts`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/tasks/TASK-009.md`

## Dependencies
- TASK-003 (核心数据模型与统一错误层)

## Inputs and Outputs
- **Inputs**: 调用目标、方法参数、原始 16 进制返回数据。
- **Outputs**: 规范 ABI 载荷或解析后的业务数据。

## Acceptance Criteria
- 严格遵循 Solidity ABI v2 规范，偏移量和长度校验严密，拒绝截断或溢出数据。
- 零依赖 ethers/viem，原生纯 TS + BigInt 实现。
- 单元测试覆盖各类正例与畸形返回反例。

## Verification Commands
- `pnpm test tests/unit/multicall3-codec.test.ts`
- `pnpm test tests/unit/erc20-codec.test.ts`
- `pnpm typecheck`

## Risks and Assumptions
- 处理 ERC-20 `name`/`symbol` 时需兼容 `bytes32` 特殊编码。

## Status
DONE
