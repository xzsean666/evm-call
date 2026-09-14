# TASK-005: 冷却追踪器与时间随机源

## Objective
实现端点故障冷却追踪器（`CooldownTracker`）与确定性时间/随机数抽象（`Clock`, `RandomSource`, Fisher-Yates `shuffle`），为节点池负载均衡与故障避退提供纯算法支撑。

## Scope
- 定义 `Clock` 和 `RandomSource` 接口，提供系统默认实现（`systemClock`, `systemRandom`）。
- 实现无偏 Fisher-Yates 洗牌算法 `shuffle`。
- 实现 `CooldownTracker`：
  - 递增阶梯惩罚时间表 `COOLDOWN_TIERS_MS`（1m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 24h）。
  - `recordFailure(now)`：记录连续失败并计算冷却截止时间。
  - `recordSuccess()`：成功时完全复位。
  - `restoreState()`：支持状态回填。
  - `getState(now)`：获取当前端点完整的冷却指标。
- 编写全面的时间敏感型单元测试（使用虚拟时钟推进与固定随机序列）。

## Allowed Files
- `src/execution/clock.ts`
- `src/execution/CooldownTracker.ts`
- `src/execution/RandomSource.ts`
- `src/execution/index.ts`
- `tests/unit/cooldown-tracker.test.ts`
- `tests/unit/random-source.test.ts`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/tasks/TASK-005.md`

## Dependencies
- TASK-003 (核心数据模型与统一错误层)

## Inputs and Outputs
- **Inputs**: 失败时间戳、模拟时钟、随机数源。
- **Outputs**: 准确的避退计算与状态快照。

## Acceptance Criteria
- 连续失败能按阶梯跃迁，并在达到 24h 上限后维持最高阶梯。
- 单次成功调用立即清空失败计数并退出冷却。
- `shuffle` 算法在均匀分布下无偏。
- 单测覆盖所有状态变迁。

## Verification Commands
- `pnpm test tests/unit/cooldown-tracker.test.ts`
- `pnpm test tests/unit/random-source.test.ts`
- `pnpm typecheck`

## Risks and Assumptions
- 避免使用全局 `setTimeout` 测试真实等待，优先使用可注入的虚拟 `Clock`。

## Status
DONE
