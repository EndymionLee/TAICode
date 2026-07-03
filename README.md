# TAICode

跨考控制寄了，机器人这条路走不通了。三月开始给自己找退路，接触到了 Agent 这个方向，感觉还挺有意思的。

毕业设计浪费了不少时间，三个月学Agent学得断断续续的。跟着 gpt 学 api post，RAG、ReAct 范式、Tools、MCP、记忆系统、多 Agent 协作、DAG ，用 Python 边学边写，也做了几个 Demo，感觉还是太浅了。

就想着做一个系统性的学习项目，Clone 了 CC 的代码。发现它真的太复杂了，硬啃了很久还是啃不下，放弃了，选择用 Python 做一个类似的项目，结果我太菜了，而且学习过程中不断修改框架、一直重构，彻底变成了屎山，Bug 多到已经无法修复，只能放弃了。

最后，决定用 TypeScript 从头开始写个低低低低低低配CC，于是有了这个学习项目。

```bash
npm install -g taicode
cd 任意目录
taicode
```

| 命令      | 作用                                               |
| --------- | -------------------------------------------------- |
| `/auto` | 切换自动放行，开启后 shell 危险操作不再弹确认      |
| `/log`  | 切换文件日志，开启后 `.TAI/logs/` 下写入调试日志 |
| `/exit` | 退出                                               |
|           |                                                    |

---

## 技术栈

TypeScript · OpenAISDK· LangGraph · LangChain · Ink/React · Emittery · Xenova Transformers

---

## 架构

```
输入
  → Gate (LLM) ─ chat  → 流式输出
               ─ task  → ifPlan (LLM) ─ simple → Worker → 汇总
                                       ─ complex → Planner(ReAct)(项目拆分为大任务) → 队列（TASK调度器）→ Splitter(ReAct)(大任务继续拆成小任务) → DAG → Validator → 汇总

底层: EventBus 解耦 · Memory(4类记忆) · 类Sandbox(4层Guard) · spanId 可观测
```

---

## 工具

12 个基础工具，Shell 无转义直接 `spawn(exe, args)`，每命令独立进程 + `killTree`。权限三级：safe 直接执行 / warn 需确认 / danger 拒绝。`python`/`pip`/`npm`/`node`/`git` 等安全解释器前缀直接放行。

`read_file` · `write_file` · `mkdir` · `cp` · `mv` · `rm` · `stat` · `ls` · `find` · `grep` · `sed` · `shell`

---

## MCP

支持 Model Context Protocol，双传输统一 JSON-RPC 2.0：

| 传输  | 说明                                                      |
| ----- | --------------------------------------------------------- |
| stdio | spawn 子进程，readline per-line JSON，10s connect         |
| SSE   | GET /sse 握手 → bracket-counting 流解析 → POST endpoint |

工具自动发现 → 注册 → 继承 Sandbox。工具名 `mcp/server/tool` ↔ `mcp_server_tool` (DeepSeek `/` 适配)。

---

## Skills

Skill RAG （使用RAG实现skill），自动索引 `.TAI/skills/` 下的 `.md` 技能手册。启动时 SHA-256 增量同步，本地 embedding (Xenova/all-MiniLM-L6-v2, 384 维)，余弦相似度检索。匹配的技能自动注入 Planner prompt。

---

| 特性                      | 说明                                                      |
| ------------------------- | --------------------------------------------------------- |
| **双层 LLM 路由**   | Gate 判断 chat/task，ifPlan 判断 simple/complex，各司其职 |
| **ReAct 观察**      | Planner/TaskSplitter 先 ls+read_file 看项目现状，再决策   |
| **Worker 四层保护** | 重复回复·重复工具·无活动·同类错误，120s 超时兜底       |
| **流式对话**        | 裸模型 stream()，不绑工具，逐 token 输出                  |
| **文件快照进度**    | mtime/size diff + 工具调用信号，不靠日志 grep             |
| **全局 ID 空间**    | remapBatch 跨批次 offset，多轮结果不覆盖                  |
| **Import 自适应**   | 非 stdlib + 非本地 → 第三方，不维护白名单                |
| **重试四维分类**    | 幻觉不重试·语法错误先修复·超时重试·Sandbox 拒绝不重试  |
| **Spec Lock**       | 文件白名单 + unexpected_file 检测，防文件漂移             |
| **可观测性**        | spanId 关联 4 通道 + 一致性断言 + Final Summary 面板      |
| **安全类沙箱**      | Budget·Path·Command·Audit 四层 Guard，纯增量不改工具   |
| **Persona 衰减**    | 30 天未提及自动过滤，记忆不膨胀                           |

---

## 版本

| 版本 | 关键变更                                                                               |
| ---- | -------------------------------------------------------------------------------------- |
| v0.3 | LangGraph 状态机 + DAG 调度器 + log                                                    |
| v0.5 | Worker 四层活动检测 (防止假死)                                                         |
| v1.0 | Persona decay · Embedding metadata                                                    |
| v1.5 | remapBatch 全局 ID · Import Validator 重写 · Final Summary · 一致性断言             |
| v1.6 | Worker 卡死修复 · PermissionManager 安全前缀 · ChatOpenAI HTTP timeout · 三层验证   |
| v1.7 | 日志改位置 .TAI/logs/ · /log 默认关闭 · spec.json/skills 迁入 .TAI · bootstrap 入口 |
| v1.8 | 大改Gate+ifPlan 双层路由 · Planner/TaskSplitter ReAct · Worker 纯执行 · 流式对话    |

---
