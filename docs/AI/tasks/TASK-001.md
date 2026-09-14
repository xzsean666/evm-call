# TASK-001: 文档与 AI 工作规范体系初始化

## Objective
建立 `evm-call` 项目的完整文档与 AI 代理工作规范体系，将用户目标精确分解为符合规范的工程架构蓝图、架构决策记录、细粒度任务索引以及首期任务定义。

## Scope
- 明确产品定位与功能范围（Pool 管理、负载均衡、CD 避退、内置/自定义 Pool、Batch Call、Multicall3；剔除代理、存储、DeFi 等冗余）。
- 创建符合《AI Agent 项目开发提示词》规范的标准文档系统：`AGENTS.md`、`docs/AI_AGENT_PROMPT.md`、`docs/AI/GOAL.md`、`docs/AI/ARCHITECTURE.md`、`docs/AI/DECISIONS.md`、`docs/AI/TASK_INDEX.md`、`docs/AI/SESSION_STATE.md`。
- 完成全部 10 个子任务的规约文件定义 (`docs/AI/tasks/TASK-001.md` ~ `TASK-010.md`)。
- 更新项目基础 `README.md`。

## Allowed Files
- `AGENTS.md`
- `README.md`
- `docs/AI_AGENT_PROMPT.md`
- `docs/AI/GOAL.md`
- `docs/AI/ARCHITECTURE.md`
- `docs/AI/DECISIONS.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/tasks/TASK-*.md`

## Dependencies
- 无（初始任务，无前置依赖）。

## Inputs and Outputs
- **Inputs**: 用户提示词规范、`/ssd0/git/EVM-Data-SDK` 源代码及架构分析。
- **Outputs**: 完整的文档架构，规范可执行的任务索引，清晰的状态记录。

## Acceptance Criteria
- [x] 创建 `AGENTS.md` 并包含 GitHub 账号路由规则（`/ssd0/git` 对应 `xzsean666`）。
- [x] 创建 `docs/AI_AGENT_PROMPT.md` 备份原始规范。
- [x] 创建 `docs/AI/GOAL.md`，明确提取范围与剔除边界。
- [x] 创建 `docs/AI/ARCHITECTURE.md`，包含 Mermaid 结构与数据流图。
- [x] 创建 `docs/AI/DECISIONS.md`，记录 ADR-001 至 ADR-006。
- [x] 创建 `docs/AI/TASK_INDEX.md` 与全部子任务规约文件。
- [x] 更新 `docs/AI/SESSION_STATE.md` 记录当前执行状态。

## Verification Commands
- 检查文件生成情况：
  ```bash
  ls -la AGENTS.md docs/AI/ docs/AI/tasks/
  ```

## Risks and Assumptions
- 假设后续工程开发使用 TypeScript 5+ 与 Node.js >= 20。

## Status
DONE
