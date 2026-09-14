# TASK-011: 端到端集成测试、示例与发布检查

## Objective
编写端到端使用示例与冒烟测试，完善项目用户文档，涵盖 SQLite 缓存、批量调用、时间戳查块与 Multicall3 场景，验证打包分发产物（ESM/CJS 双格式导出与 TypeScript 类型声明），完成首个可用版本闭环。

## Scope
- 编写端到端集成测试与冒烟测试（`tests/integration/`）：
  - 10 秒短效缓存命中与穿透测试。
  - 历史归档长效缓存与过期清理 (`cleanExpiredCache`) 测试。
  - 批量 JSON-RPC 自动切片与 failover 测试。
  - Multicall3 聚合读取与代币余额测试。
- 编写真实使用示例（`examples/`）：
  - `examples/batch-json-rpc.ts`：普通及归档批量 RPC 调用示例。
  - `examples/sqlite-cache-demo.ts`：10 秒最新态与长效历史态缓存演示。
  - `examples/multicall-erc20.ts`：Multicall3 批量读取代币余额示例。
  - `examples/custom-rpc-pool.ts`：自定义私有 RPC 节点注入与故障避退演示。
- 完善 `README.md`，提供清晰的 Quick Start、API 参考和架构说明。
- 验证生产构建产物（`pnpm build` -> 生成 `dist/`，检查 `.d.ts` 与 runtime 文件）。

## Allowed Files
- `README.md`
- `examples/*`
- `tests/integration/*`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/tasks/TASK-011.md`

## Dependencies
- TASK-010 (聚合服务层与统一客户端 Facade)

## Inputs and Outputs
- **Inputs**: 完整的源码实现与构建配置。
- **Outputs**: 验证通过的可发布产物与详尽的使用指南。

## Acceptance Criteria
- `pnpm build` 无类型错误，产物正常生成且无依赖泄露。
- 示例代码语法正确、运行逻辑通畅。
- `README.md` 清晰指导用户如何在业务微服务中使用本基座。

## Verification Commands
- `pnpm build`
- `pnpm test`
- `pnpm typecheck`

## Risks and Assumptions
- 生产环境构建不得包含任何未编译的测试代码或临时文件。

## Status
DONE
