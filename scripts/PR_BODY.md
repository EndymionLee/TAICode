# [优化+修复] 缓存命中与任务效率全链优化,附 7 项缺陷修复与 77 例测试

对 TAICode 做了一轮系统性的缺陷修复与性能优化:端到端任务时延 **31s → 14-19s**(-42~55%),DeepSeek 前缀缓存命中率从不可见提升到 **80.3%**(输入成本按命中 1/10 价折算约 -71%),并补齐了 **77 例单元测试**(原仓库 0 测试)。全部改动不新增任何模型能力约束——只做工程加固,反而解除了原版两处对模型的误杀。

## 一、缺陷修复(7 项批判问题 + 6 项连带 bug)

| # | 问题 | 修复 |
|---|---|---|
| 1 | 零测试 | `tests/` 9 文件 77 用例(node:test + tsx,`npm test`) |
| 2 | Validator 仅支持 Python | JS/TS `import/require/export from/动态 import` 提取、package.json 依赖校验(JSON 解析回写,禁止文本追加) |
| 3 | 文件名正则脆(中文漏配/多级扩展名截断) | `core/file-refs.ts` Unicode 健壮提取,全系统替换 |
| 4 | 每 Worker 每步全盘快照(IO 炸弹) | `core/snapshot-service.ts` 进程级共享单例 + fs.watch 增量 + 防抖降级 |
| 5 | 状态机无强制力(双轨漂移) | `task/state-machine.ts` 唯一推进入口,违规计数+自愈,`TAICODE_STRICT_STATE=1` 可抛异常 |
| 6 | DAG 外层 120s 超时必杀内层重试 | 外层超时按内层预算推导(90s×3+90s=360s),超时 resolve 标准失败结果不再击穿主循环,Worker `shouldAbort` 步边界退出 |
| 7 | 记忆偏陪伴向 | 新增 ProjectMemory 工程记忆层(跨会话)、向量范数缓存、`TAICODE_EMBED_MODEL` 可配中文模型 |
| 8 | *(连带)* 任务计数不齐 + Consistency× | `allTasks` 结算台账 |
| 9 | *(连带)* Python missing_import 死代码 | 五分类重写 |
| 10 | *(连带)* 重试重复拼接 task.description | WeakSet 一次性准备 |
| 11 | *(连带)* Windows 兜底路径正则丢多级段 | 完整路径 + dirname 语义 |
| 12 | *(连带)* 状态表 EXECUTING→SUMMARIZING 自相矛盾 | 纠偏并有测试锁定 |
| 13 | *(连带)* completedFiles basename 直查永不命中 | 后缀匹配 |

## 二、性能优化(P0/P1/P2)

**缓存命中(前缀纪律)**:cache-telemetry 遥测(修复 LangChain usage 字段假象:`usage_metadata.input_token_details.cache_read` 才是标准化命中数)/ spec 共享注入进所有 Worker system 尾部(CLAUDE.md 模式,跨 Worker 命中)/ 模板版本冻结(`PROMPT_VERSION`)。

**任务效率(砍往返)**:小工作区观察注入(≤50 项机械清单免 ReAct 观察)/ spec 会话级复用(指纹关联+轮末回写)/ 前置产物内联(≤8KB 全文,总预算 24KB)/ 验证前移(Worker 收尾强制 py_compile/node --check,失败同循环自修复≤2轮)/ 单批快速路径 / 上下文折叠(工具结果 2KB 截断+40 条折叠)。

**鲁棒性**:模型分级(`LLM_GATE_MODEL`)/ Worker 契约 `blocked_on`+`confidence`/ 依赖终态失败下游 skip-with-reason / Validator 轻量局部重规划(missing_import→单文件修复任务)。

## 三、实测数据(DeepSeek deepseek-chat,同款 calc 任务)

| 指标 | 基线 | 优化后 |
|---|---|---|
| 端到端时延 | 31s | 14-19s(改进类任务 ~10s) |
| 缓存命中率 | 不可见 | 80.3%(33920/42238 tokens) |
| 任务成功率 | — | 三轮连续 E2E 全过(创建/加函数/改消息),产物测试全绿 |
| 单元测试 | 0 | 77/77 |

缓存 miss 解剖:Worker 81.6% 命中(每任务独有内容为架构固有 miss),Gate/ifPlan 22.9%(已用模型分级收割)。

## 四、验证方式

```bash
npm install
npm test          # 77 用例
npm run typecheck # 双 tsconfig 零错误
```

8 个语义化 commit 按依赖顺序排列(fix(task) → feat(validator) → feat(memory) → test → fix(graph) → perf×3),每个提交点可独立编译。
