# TASK-002: 项目骨架与工程构建配置

## Objective
初始化 `evm-call` 项目的工程基础配置，搭建现代 TypeScript 构建环境、包管理配置、代码规范与自动化单元测试运行器（Vitest）。

## Scope
- 配置 `package.json`（设定 ESM/CJS 混合导出、依赖项、脚本）。
- 配置 `tsconfig.json` 与 `tsconfig.build.json`（严格类型检查、NodeNext 模块解析）。
- 配置 `tsup.config.ts`（支持现代极速打包与 `.d.ts` 类型生成）。
- 配置 `vitest.config.ts`（支持单元测试与覆盖率统计）。
- 配置 `.gitignore`。
- 安装最小必要依赖（仅保留极轻量库：`zod`、`axios` 或原生轻量依赖，开发依赖包含 typescript、vitest、tsup）。

## Allowed Files
- `package.json`
- `pnpm-lock.yaml`
- `tsconfig.json`
- `tsconfig.build.json`
- `tsup.config.ts`
- `vitest.config.ts`
- `.gitignore`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/tasks/TASK-002.md`

## Dependencies
- TASK-001 (文档与 AI 工作规范体系初始化)

## Inputs and Outputs
- **Inputs**: Node.js 20+ 环境，pnpm 包管理器。
- **Outputs**: 可直接运行 `pnpm build`、`pnpm test`、`pnpm typecheck` 的工程脚手架。

## Acceptance Criteria
- `package.json` 配置合理，无冗余重度依赖。
- TypeScript 配置支持严格模式（`strict: true`）。
- `vitest` 可正常执行测试命令（即使为空用例通过）。
- 打包输出目录配置规范（`dist/`）。

## Verification Commands
- `pnpm install`
- `pnpm typecheck`
- `pnpm test`

## Risks and Assumptions
- 假设本地已安装 `pnpm` 和 Node.js >= 20。

## Status
DONE
