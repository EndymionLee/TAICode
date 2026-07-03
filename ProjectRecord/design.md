# TAICode 设计文档

## 概述

TAICode 是一个 AI 编程助手。用户输入自然语言，系统自动判断意图、拆解任务、并行执行、验证、汇总，最终产出完整可运行的项目代码。基于 Ink/React TUI 交互。

```
cd 任意目录 && taicode  # 从任意目录启动
数据存入 .TAI/ (logs/sessions/persona/spec.json/skills/)
```

---

## 核心架构

```
用户输入
  → Gate (LLM) 判断 chat / task
    ├─ chat → 裸模型流式对话（不绑工具，保证逐 token 输出）
    └─ task → ifPlan (LLM + 短期记忆) 判断 simple / complex
              ├─ simple → Worker (纯执行) → MainAgent (汇总)
              └─ complex → Planner (ReAct) → TaskSplitter (ReAct) → DAG → Validator → MainAgent

底层支撑: EventBus 解耦 + Memory(4类记忆+EMA流水线) + Sandbox(4层Guard) + spanId 可观测
```

入口链: `index.ts` (bootstrap, 捕获启动错误) → `main.ts` (Windows `chcp 65001` UTF-8 强设) → `startTui()`

---

## 模块设计

### 1. 任务系统 `task/`

#### 1.0 双层路由（v1.8）

每次用户输入经过两次 LLM 判断，各司其职：

**Gate** (`TASK_GATE_PROMPT`) —— 判断意图是对话还是任务。一次 LLM 调用，输出 `{"intent":"chat|task"}`。带上编译后的上下文（`compileContext`），能理解"改进一下""继续"等依赖上文的请求。

**ifPlan** (`IF_PLAN_PROMPT`) —— 判断任务的复杂度。带短期记忆（最近 5 轮对话原文），输出 `{"needDecompose": true/false, "workspace": "..."}`。简单任务走单 Worker 直接执行，复杂任务走 Planner→DAG 流水线。

设计原则：Gate 只管是不是任务（粗筛），ifPlan 管多复杂（细判）。两层 LLM 但各只做一件事，比之前一层 LLM 做三分类更稳定。

#### 1.1 LangGraph 状态机

7 节点: `main_agent → if_plan → planner → task_splitter → dag_scheduler → validator → simple_worker`

Router 优先级: `dagCompleted`（显式完成标记）> `finalAnswer 有内容`（`!!val && val.trim().length > 0`，不用 `if(value)`）> `loopCount > 5`（死循环保护）> 正常流转

**RuntimeState 显式状态机** (v0.7): `IDLE → IF_PLAN → PLANNING → SPLITTING → EXECUTING → VALIDATING → SUMMARIZING → FINISHED`。`VALID_TRANSITIONS` 表定义合法转换，`transition()` 验证每次转换（非法时打 error 日志不抛异常——LangGraph 状态传播机制需要容错）。5 个分散 router 函数合并为 1 个 `unifiedRouter(state, fromNode)`。

19 个状态字段全部由显式状态机管理。加新状态时编译期可检查合法性。

#### 1.2 Planner（ReAct 模式）

v1.8 改为真正的 ReAct Agent：先用 `ls` 查看工作目录下有哪些文件，用 `read_file` 读取 spec.json 和已有代码了解项目现状，再基于观察结果拆分大任务。工具结果私有，不共享给下游。

输出 `bigTasks: [{ goal, files }]`——每个大任务描述目标并指定预期产出的文件清单。`spec.json` 落盘到 `.TAI/` 目录，Worker 共享。

#### 1.3 TaskSplitter（ReAct 模式）

同样改为 ReAct：先用 `ls` 和 `read_file` 观察当前文件状态，再拆小任务。"一个文件 = 一个任务"原则。同文件多任务自动合并（防上下文断裂）。`completedFiles` 去重——双保险：Prompt 告知已完成文件列表让 LLM 自觉跳过；代码层硬过滤 create 类任务。

#### 1.4 DAG 调度器

事件驱动调度：`findReadyTasks()` 依赖解析 → `Promise.race` 等待最先完成的 Worker → 解锁新依赖 → 继续调度（不是 batch wait-all）。8 Worker 信号量并发。文件锁：正则提取文件名，同文件不同 Worker 互斥。120s 单任务超时。

依赖上下文注入：Worker 启动前，解析直接前置任务的 JSON 结果，提取 `summary/cwd/created` 字段注入当前任务描述。

重试四维分类 (v0.7): `ErrorClassification { category: "llm"|"tool"|"sandbox"|"validation", retriable, repairable }`。幻觉/重复思考 → 直接失败不重试。LLM 超时 → 重试。语法错误/ImportError → 需修复，不消耗重试次数。Sandbox 拒绝 → 不重试。

`remapBatch()` (v1.5): 跨 DAG 批次全局 ID offset，tasks/results/logs/completed 统一 remap，防止后续批次覆盖前序结果。

#### 1.5 Worker 引擎

纯执行角色（v1.8：Planner/TaskSplitter 已观察过项目，Worker 只管干活）。ReAct 循环：LLM 调用 → 工具执行 → 验证 → 输出 JSON。

四层死循环检测:
- 重复回复: LLM 文本全等 ×3 → 思考循环
- 幻觉: 首轮不调工具 + 任务需要工具 → 立即退出
- 重复工具: `toolName:JSON.stringify(args)` 全等 ×6 → 死循环
- 无活动: 工具调用 OR 文件变化 ×20 步 → 假死

活动信号检测（三次迭代的最终方案）：不用日志 grep 中文文案（工具结果在 messages 不在 logs），改用文件系统快照 diff（mtime/size）+ 工具调用信号。核心洞察：文件变化是滞后信号（LLM 先读后写），工具调用是即时信号，两者互补。

自适应步数：复杂度打分（CNN×3, 函数×2, 普通×1）+ 文件计数 → 起步 20, 自动续期至 100。

结构化输出: `parseWorkerOutput()` — JSON parse 失败返回标准化 error JSON（`{ status:"failed", summary:"输出格式错误", ... }`），字段补全，永不透传 raw text。LLM 常见拼写错误容错（`sumary` → `summary`）。

验证规则（三层）: Lint（`python -c "import xxx"`，所有文件）→ Smoke（模型类实例化+一次前向传播，<10s）→ Full（train/test.py 可选，120s 超时）。

#### 1.6 Validator

DAG 完成后验证项目完整性:
- import 交叉引用: 解析 `from X import Y` 和 `import X`，检查引用的本地模块文件是否已创建
- 第三方识别: "非 stdlib + 非本地文件 → 第三方"，不维护白名单
- requirements.txt 完整性: 收集所有第三方引用，检查是否在 requirements.txt 中
- spec 约束检查: grep `禁止eval` 等约束
- unexpected_file (v0.9): 对比实际产出 vs spec.files 白名单，检测文件漂移
- 自动修复: 最多 3 轮，目前支持 missing_dep 自动追加

#### 1.7 MainAgent 汇总

同文件多版本去重（只保留最新版本）。紧凑格式 `[#id] summary`。≤5 个任务时跳过 LLM 直接结构化输出（省 token），>5 个任务走 LLM 自然语言汇总。输出带统计：文件数、任务成功/失败/跳过数。

Final Summary (v1.5): 任务/结果/日志/文件数一致性断言，非法状态差集定位，Duration 追踪。

#### 1.8 completedFiles 去重

`Record<string, FileState>` — 相对路径 key（v0.8），含 `lastTaskId/lastAction/modifiedAt` 来源追溯。跨大任务追踪。双保险: Prompt 避重 + 代码硬过滤。

---

### 2. Sandbox 安全沙箱 `core/sandbox/`

所有工具调用必须过四层 Guard，纯增量设计（不改工具代码，在 `deepCloneTools()` wrapper 中统一注入）:

```
Tool Call → BudgetManager (命令数/时间/输出/文件变更 四维上限)
  → PathGuard (路径白名单, Windows lowercased 比较, TAICODE_CWD 优先)
  → PermissionManager (safe/warn/danger 三级, 安全解释器前缀白名单)
  → AuditLog (JSONL 追加, 自动附加 traceId/spanId)
```

默认预算: 100 命令 / 5 分钟 / 10MB 输出 / 1000 文件变更。每批 DAG 前 reset()。

PathGuard: `path.resolve(cwd ?? TAICODE_CWD ?? process.cwd(), inputPath)` 规范化。`approve()` 白名单机制。`TAICODE_CWD` 优先于 `process.cwd()` 解决工作目录漂移。

PermissionManager: 先匹配 danger 再匹配 warn。`format/diskpart/rm -rf /` 直接拒绝。`python/pip/npm/node/git/ls` 等安全解释器前缀直接放行，不检查危险模式（v1.6 修复 `models` 含 `del` 误判）。

---

### 3. LLM 客户端 `core/llm/`

配置降级链（6 级 env fallback）: `cfg → LLM_BASE_URL → DEEPSEEK_BASE_URL → https://api.deepseek.com/v1`

DeepSeek 适配: `sanitizeFnName()` — `[^a-zA-Z0-9_-]` 替换为 `_`。MCP 工具 `mcp/server/tool` ↔ `mcp_server_tool` 双向映射。

ChatOpenAI 构造函数加 `timeout: 90_000` (v1.6)，从 HTTP 层面强制超时，比 Promise.race + setTimeout 更可靠。

Embed 三级降级（永不失败）: 本地 Xenova/all-MiniLM-L6-v2 (~80MB, 384 维, 懒加载单例, mean pooling + L2 normalize) → API OpenAI-compatible (text-embedding-3-small) → n-gram hash (纯 JS 128 维 bigram+trigram L2 归一化)

---

### 4. 工具系统 `core/tools/`

12 基础工具: `read_file/write_file/mkdir/cp/mv/rm/stat/ls/find/grep/sed/shell`。MCP 协议扩展。

注册中心: `toolsList → TOOL_MAP → deepCloneTools()`（Sandbox guard + 日志 + 计时 + 输出大小追踪 wrapper）。Chat 模式不绑工具（裸模型流式）。

特色实现:
- **grep**: 流式读取 + ring buffer 上下文 (`context×2+1`)，跳过 >100MB 文件，全局上限 500 结果
- **sed**: old_str 精确匹配强制唯一（出现次数 ≠ 1 直接拒绝），insert_after/insert_before 同样唯一性检查
- **JSON 修复**: markdown fence 提取 → brace-counting 状态机（跟踪 `{}/"` / 转义）→ 去尾逗号 → 单引号转双引号 → 字段提取
- **Shell**: `parseCommand()` 按空格和双引号分词，不经过 `cmd.exe /c`。每命令独立 `spawn(exe, args)` + `detached: true` + `killTree`。60s 默认超时。approval 阻塞执行 + 30s 超时默认放行 (v0.8)
- **resolvePath**: 默认基准 `TAICODE_CWD ?? process.cwd()`，解决工作目录漂移 (v1.8)

---

### 5. EventBus `core/events.ts`

基于 Emittery 的类型安全事件系统。30+ 事件类型编译期参数检查。核心原则: Runtime 只 emit，UI 只 subscribe，互不知对方存在。换 UI 只换订阅端。

TUI 端 FrameScheduler 16ms 批量合并（多次 `requestFlush()` → 一次 React re-render）。关键事件 `flushNow()` 跳过定时器。

Phase 生命周期: `idle → planning → running → validating → summarizing → idle`。UI 按阶段切换显示。

---

### 6. 认知记忆 `memory/`

四种记忆 + Context Compiler EMA 流水线:

```
收集 (短期/语义/画像/规则)
  → 语义重要度评分 (技术×0.9, 闲聊×0.4)
  → EMA 平滑 (alpha=0.7, 永生标记跳过, 旧分<0.05 删除)
  → 槽位保护 (PERSONA≥2, CONSTRAINT≥1, GOAL≥1, KNOWLEDGE≥2, MAX=8)
  → 结构化输出 [PERSONA][GOAL][CONSTRAINT][KNOWLEDGE][STYLE]
```

短期记忆: 滑动窗口 10 条，`toText(5)` 返回最近 5 轮对话原文（"用户: ...\nAI: ..."），传给 Gate/ifPlan 做上下文。

Persona decay (v1.0): `_firstSeen/_lastSeen` 时间戳追踪，30 天未提及自动过滤。

语义去噪: <20 字/纯数字/问候/感谢/确认 → 不写入语义记忆，防污染。

Task 模式 STYLE 降权到 0.1，避免代码注释带"可爱"风格。

---

### 7. MCP 客户端 `core/mcp/`

双传输 + 统一 JSON-RPC 2.0:

```
stdio: spawn 子进程 → readline per-line JSON → 10s connect → listTools
sse:   GET /sse → bracket-counting stream parser (TCP 分片 → 深度计数 → 完整 JSON) → POST endpoint → 30s 响应超时
```

工具能力推断: 安全词黑名单（先剔除 `mcp/http/tcp/grpc` 再正则匹配）→ EXEC→WRITE→READ 三阶 → 默认 read（最保守）。自动继承 Sandbox。

---

### 8. TUI

Ink 5 + React 18 + Yoga Flex 布局。三层架构: EventBus → State → FrameScheduler(16ms) → React Components。

Braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, 120ms), SGR mouse tracking (滚轮 + PgUp/PgDown), 200 行消息缓冲。视觉行裁剪 (`stringWidth / cols`)。

`/auto` 切换自动放行，`/log` 切换文件日志输出（默认关闭，开启后 `.TAI/logs/` 下写入 taicode/main-agent/heartbeat/audit 四个日志）。

---

### 9. 可观测性 `core/trace.ts` (v0.8)

轻量 span 系统，不引入 OpenTelemetry: `SpanContext { traceId, spanId, parentSpanId }`。全局变量传播，`newTrace()` 覆盖 `_current`。

Worker 启动 `newTrace()` → 每步 `newSpan(trace, "step-N")` → Logger 文件输出自动附加 `[tr-N/sp-M]` 前缀 → Sandbox AuditLog 自动附加 traceId/spanId → 工具执行日志带 span。

效果: 任一条日志/审计记录可追溯到具体 Worker step 和用户请求。

---

### 10. 意图识别 `core/intent.ts`

五级分类: `chat | simple_task | complex_task | mixed | question_about_task`

Hybrid 三阶段: 规则层 (置信度 0.9-1.0) → LLM 层 (0.7) → Fallback (0.3, 默认 complex_task)

True LRU Cache: `Map<string, IntentResult>`, 1000 上限, 1h TTL。命中时 `delete + re-insert`（移到末尾，Map 插入序保证）。

注: v1.8 后 Gate 取代了 intent 在路由中的作用，intent 模块保留用于参考和 LLM fallback。

---

### 11. ReAct Agent `task/react-agent.ts` (v1.8)

Planner/TaskSplitter 专用的轻量 ReAct 引擎。与 Worker 的区别: 只有 read 工具（ls/read_file/grep/find/stat），不写文件不调 shell。工具结果私有，不共享。无四层检测。上限 8-10 步。

`reactAgent(systemPrompt, userPrompt, maxSteps)` → 返回 LLM 最终文本输出。

---

## 目录结构

```
src/
├── index.ts                     # bootstrap 入口 (import main.js + .catch)
├── main.ts                      # TUI 启动 + chcp 65001
├── core/
│   ├── types.ts                 # 共享类型 + ErrorClassification + FileState
│   ├── llm.ts / llm/            # LLM 客户端 (adapter + embed 三级降级)
│   ├── logger.ts                # 双通道日志 (console + 文件 .TAI/logs/ + EventBus)
│   ├── events.ts                # EventBus + 类型安全 helpers
│   ├── trace.ts                 # 轻量 spanId (v0.8)
│   ├── intent.ts                # 五级意图识别 + LRU Cache
│   ├── context-compiler.ts      # Context Compiler EMA 流水线
│   ├── json-utils.ts            # JSON 提取 (brace-counting) + 修复
│   ├── skill-index.ts           # Skill RAG (增量同步 + 语义检索, 存 .TAI/skills/)
│   ├── sandbox/                 # 安全沙箱 (Guard + Path + Budget + Audit)
│   ├── mcp/                     # MCP 客户端 (stdio + SSE)
│   └── tools/                   # 工具注册 + 12 基础工具 + PowerShell
├── task/
│   ├── graph.ts                 # LangGraph 状态机 + RuntimeState + remapBatch
│   ├── react-agent.ts           # ReAct Agent (Planner/TaskSplitter 专用, v1.8)
│   ├── dag-scheduler.ts         # DAG 事件驱动 + 重试四维分类
│   ├── worker.ts                # Worker 引擎 + 四层检测 + 快照 + parseWorkerOutput
│   ├── prompts.ts               # 全部提示词模板 (Gate/ifPlan/Planner/Splitter/Worker/MA)
│   ├── validator.ts             # 项目验证 + Spec Lock v2 + isLocalModule
│   └── semaphore.ts             # 轻量信号量
├── memory/memory-system.ts      # 4 类记忆 + Context Compiler + Persona decay
├── runtime/session.ts           # 统一会话管理 (Gate 路由 + 流式对话)
└── tui/                         # Ink TUI (app + components + state + frame-scheduler)
```

---

## 关键技术决策

1. Gate + ifPlan 双层 LLM 路由 — 各做一件事，比单层三分类更稳定
2. Planner/TaskSplitter ReAct — 先观察项目再决策，工具结果私有
3. Worker 纯执行 — 不观察不探索，只管干活
4. 对话裸模型流式 — 不绑工具，保证 DeepSeek 逐 token 输出
5. EventBus 解耦 — Runtime/UI 互不知对方存在，换 UI 只换订阅端
6. 文件快照 + 活动信号 — 不靠日志 grep, 工具调用即活动
7. 四层死循环检测 — 单靠一种不够 (滞后 vs 空转)
8. 显式状态机 — RuntimeState + VALID_TRANSITIONS + unifiedRouter
9. Worker 输出强制结构化 — JSON parse 失败返回标准化 error, 不透传
10. 重试四维分类 — 幻觉不重试, 语法错误先修复, 超时重试
11. completedFiles 双保险 — Prompt 引导 + 代码硬过滤
12. Sandbox Guard 纯增量 — 不改工具代码, deepCloneTools 统一注入
13. spawn 替代 PTY — 每命令独立进程, 无 shell 转义
14. Spec Lock v2 — spec.json 文件白名单 + unexpected_file 检查
15. Summary 三道防线 — Prompt 60 字 + hard truncate 120 字 + 紧凑格式
16. 轻量 spanId — 不引入 OpenTelemetry, 全局变量传播
17. Embed 永不失败 — 本地→API→n-gram hash 三级降级
18. Persona 时间衰减 — 30 天未提及自动过滤
19. Import 非本地即第三方 — 不维护白名单，自适应
20. 全局 ID 空间 — remapBatch 跨批次 offset, 防覆盖
21. TAICODE_CWD 优先 — resolvePath/PathGuard/Validator 统一使用, 解决工作目录漂移

---

## 版本

| 版本 | 关键变更 |
|------|---------|
| v0.3 | LangGraph 状态机 + DAG 调度器 |
| v0.4 | Sandbox + MCP + Spec Lock |
| v0.5 | Worker 四层活动检测 (快照 diff + 工具调用信号) |
| v0.6 | completedFiles 去重 + Summary 压缩 |
| v0.7 | 状态机显式化 + Worker 结构化输出 + 重试四维分类 |
| v0.8 | 四通道 spanId + Shell approval 阻塞 + 相对路径 key |
| v0.9 | ifPlan 规则优先 + MainAgent 结构化 + Spec Lock v2 → 之后改为全 LLM |
| v1.0 | Persona decay + Embedding metadata |
| v1.5 | 状态机修复 + remapBatch 全局 ID + Import Validator 重写 + Final Summary |
| v1.6 | Worker 卡死修复: heartbeat 泄漏 + PermissionManager 白名单 + ChatOpenAI timeout + 三层验证 |
| v1.7 | 日志归位(.TAI/logs/) + /log 默认关闭 + spec.json/skills 迁入 .TAI + index.ts bootstrap |
| v1.8 | Gate + ifPlan 双层 LLM 路由 + Planner/TaskSplitter ReAct + Worker 纯执行 + 流式对话 |
