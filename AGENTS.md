# Project Rules & Agent Guidelines (项目规则与代理守则)

## 1. GitHub 账户与认证路由规范
本项目位于 `/ssd0/git/evm-call`，属于 `/ssd0/git` 目录体系：
- **指定 GitHub 账号**: `xzsean666`
- **执行规范**:
  - 在执行任何 `gh` 命令或 Git 认证操作前，必须确保当前活跃账号为 `xzsean666`。
  - 如需切换账号，执行：
    ```bash
    gh auth switch --user xzsean666
    ```
  - 未经用户明确许可，不得执行 `git push`、`git reset --hard`、`git checkout` 等破坏性或发布性操作。

## 2. 工程质量与实现原则
1. **单一职责与范围控制**:
   - 一次只处理一个 Goal 与一个当前 Task。
   - 严禁擅自扩大范围或添加未经 Task 批准的第三方依赖。
   - 不修改与当前 Task 无关的代码与文件。
2. **事实来源 (Source of Truth)**:
   - `AGENTS.md`：项目全局规则与环境约束。
   - `docs/AI/GOAL.md`：产品功能全景与边界（明确 In-Scope 与 Out-of-Scope）。
   - `docs/AI/TASK_INDEX.md`：任务状态流与依赖索引。
   - `docs/AI/SESSION_STATE.md`：跨 session 恢复与当前执行快照。
   - `docs/AI/ARCHITECTURE.md`：系统架构与模块划分。
   - `docs/AI/DECISIONS.md`：技术决策记录 (ADR)。
   - `docs/AI/tasks/TASK-xxx.md`：具体任务的验收指标与可执行范围。
3. **测试驱动与验证**:
   - 所有声明通过的功能必须经过真实命令验证并输出执行结果。
   - 保持单元测试快速、独立且具备高覆盖率。
4. **轻量纯净与高性能**:
   - `evm-call` 的核心定位是“最基础、最可靠的轻量级 EVM RPC 基座 SDK”。
   - 杜绝重型 Web3 全家桶（如不需要 ethers/viem 庞大依赖，Multicall3 与基础 ERC-20 采用高效纯 TS ABI 编解码）。
   - 剔除上层复杂业务（不包含 Uniswap 数学、Chainlink 预言机数据库、Postgres 存储、SingBox 代理层等）。
