# evm-call 任务索引 (Task Index)

本索引严格遵循《AI Agent 项目开发提示词》规范进行编排与状态追踪。

---

## 状态总览 (Status Overview)

| 任务编号 | 任务名称 | 目标模块 | 依赖前置 | 预估文件量 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **TASK-001** | 文档与 AI 工作规范体系初始化 | `docs/` & 规范 | 无 | 18 docs | **DONE** |
| **TASK-002** | 项目骨架与工程构建配置 | 基础设施与工程流 | TASK-001 | 5 files | **DONE** |
| **TASK-003** | 核心数据模型与统一错误层 | `src/domain` | TASK-002 | 4 files | **DONE** |
| **TASK-004** | 传输层与 JSON-RPC 协议驱动 | `src/transport` | TASK-003 | 4 files | **DONE** |
| **TASK-005** | 冷却追踪器与时间随机源 | `src/execution` | TASK-003 | 4 files | **DONE** |
| **TASK-006** | SQLite 统一存储与多层级 RPC 缓存服务 | `src/storage` | TASK-003 | 4 files | **DONE** |
| **TASK-007** | 内置节点列表与 RPC 节点池管理器 | `src/pool` | TASK-004, TASK-005, TASK-006 | 4 files | **DONE** |
| **TASK-008** | JSON-RPC 批量调用执行器（集成缓存与 Archive 支持） | `src/batch` | TASK-004, TASK-006, TASK-007 | 3 files | **DONE** |
| **TASK-009** | Multicall3 纯 ABI 编解码与 ERC-20 只读解析器 | `src/multicall` | TASK-003 | 3 files | **DONE** |
| **TASK-010** | 聚合服务层与统一客户端 Facade | `src/client` & `index.ts` | TASK-006, TASK-007, TASK-008, TASK-009 | 3 files | **DONE** |
| **TASK-011** | 端到端集成测试、示例与发布检查 | `tests/` & `examples/` | TASK-010 | 4 files | **DONE** |

---

## 任务详情链接 (Task Specifications)

1. [TASK-001: 文档与 AI 工作规范体系初始化](tasks/TASK-001.md)
2. [TASK-002: 项目骨架与工程构建配置](tasks/TASK-002.md)
3. [TASK-003: 核心数据模型与统一错误层](tasks/TASK-003.md)
4. [TASK-004: 传输层与 JSON-RPC 协议驱动](tasks/TASK-004.md)
5. [TASK-005: 冷却追踪器与时间随机源](tasks/TASK-005.md)
6. [TASK-006: SQLite 统一存储与多层级 RPC 缓存服务](tasks/TASK-006.md)
7. [TASK-007: 内置节点列表与 RPC 节点池管理器](tasks/TASK-007.md)
8. [TASK-008: JSON-RPC 批量调用执行器（集成缓存与 Archive 支持）](tasks/TASK-008.md)
9. [TASK-009: Multicall3 纯 ABI 编解码与 ERC-20 只读解析器](tasks/TASK-009.md)
10. [TASK-010: 聚合服务层与统一客户端 Facade](tasks/TASK-010.md)
11. [TASK-011: 端到端集成测试、示例与发布检查](tasks/TASK-011.md)
