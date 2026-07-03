/**
 * Task Graph — LangGraph 状态机: 规划 → 调度 → 汇总
 */
import { StateGraph, Annotation, messagesStateReducer, START, END } from "@langchain/langgraph";
import { HumanMessage, AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { createLLMClient } from "../core/llm.js";
import {
  extractJson, safeJsonParse, computeDependencies,
  type SubTask, type ResourceTask, type FileState,
} from "../core/types.js";
import type { ToolDefinition } from "../core/types.js";
import { createLogger, isFileLoggingEnabled } from "../core/logger.js";
import { IF_PLAN_PROMPT, PLANNER_PROMPT, TASK_SPLITTER_PROMPT, MAIN_AGENT_SUMMARY_PROMPT } from "./prompts.js";
import { DAGScheduler, normalizeDependencies, mergeDependencies, countParallelGroups } from "./dag-scheduler.js";
import { reactWorker } from "./worker.js";
import { reactAgent } from "./react-agent.js";
import { validateProject, autoFix } from "./validator.js";
import { searchSkills } from "../core/skill-index.js";
import { events } from "../core/events.js";
import * as fs from "fs";
import * as path from "path";

const log = createLogger("task:graph");
const llm = createLLMClient({ temperature: 0 });
const dagScheduler = new DAGScheduler();

// ============================================================================
// 显式状态机 — RuntimeState 替代隐式状态转换
// ============================================================================

enum RuntimeState {
  IDLE = "idle",
  IF_PLAN = "if_plan",
  PLANNING = "planning",
  SPLITTING = "splitting",
  EXECUTING = "executing",
  VALIDATING = "validating",
  REPAIRING = "repairing",
  SUMMARIZING = "summarizing",
  FINISHED = "finished",
}

const VALID_TRANSITIONS: Record<RuntimeState, RuntimeState[]> = {
  [RuntimeState.IDLE]:        [RuntimeState.IF_PLAN],
  [RuntimeState.IF_PLAN]:     [RuntimeState.PLANNING, RuntimeState.EXECUTING],
  [RuntimeState.PLANNING]:    [RuntimeState.SPLITTING],
  [RuntimeState.SPLITTING]:   [RuntimeState.EXECUTING],
  [RuntimeState.EXECUTING]:   [RuntimeState.VALIDATING],
  // 大任务循环: VALIDATING → SPLITTING (多轮) 或 EXECUTING (TaskSplitter 拆完直接执行)
  [RuntimeState.VALIDATING]:  [RuntimeState.SPLITTING, RuntimeState.EXECUTING, RuntimeState.SUMMARIZING, RuntimeState.REPAIRING],
  [RuntimeState.REPAIRING]:   [RuntimeState.VALIDATING, RuntimeState.SUMMARIZING],
  [RuntimeState.SUMMARIZING]: [RuntimeState.FINISHED],
  [RuntimeState.FINISHED]:    [],
};

function transition(from: RuntimeState, to: RuntimeState, context: string): void {
  // 幂等转换 — 同状态直接返回
  if (from === to) return;
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    log.error(`非法状态转换: ${from} → ${to} (${context})`);
    // 不抛异常 — 生产环境记录但不中断，避免 LangGraph 状态污染
  } else {
    log.debug(`状态: ${from} → ${to} (${context})`);
  }
}

// Main Agent 专用日志
const MA_LOG = path.resolve(process.env.TAICODE_CWD ?? process.cwd(), ".TAI", "logs", "main-agent.log");
function maLog(msg: string): void {
  if (!isFileLoggingEnabled()) return;
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  try {
    const dir = path.dirname(MA_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(MA_LOG, `[${ts}] ${msg}\n`, "utf-8");
  } catch { /* ignore */ }
}

// ============================================================================
// 状态定义
// ============================================================================

const TaskAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  userInput: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),
  needDecompose: Annotation<boolean>({ reducer: (_c, n) => n, default: () => false }),
  tasks: Annotation<SubTask[]>({ reducer: (_c, n) => n, default: () => [] }),
  dependencies: Annotation<Record<string, number[]>>({ reducer: (_c, n) => n, default: () => ({}) }),
  completedTasks: Annotation<number[]>({ reducer: (_c, n) => n, default: () => [] }),
  taskResults: Annotation<Record<number, string>>({ reducer: (_c, n) => n, default: () => ({}) }),
  taskLogs: Annotation<Record<number, string[]>>({ reducer: (_c, n) => n, default: () => ({}) }),
  finalAnswer: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),
  bigTaskIndex: Annotation<number>({ reducer: (_c, n) => n, default: () => 0 }),
  bigTasks: Annotation<SubTask[]>({ reducer: (_c, n) => n, default: () => [] }),
  workspace: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),
  spec: Annotation<string[]>({ reducer: (_c, n) => n, default: () => [] }),
  specFiles: Annotation<string[]>({ reducer: (_c, n) => n, default: () => [] }),
  contract: Annotation<Record<string, number>>({ reducer: (_c, n) => n, default: () => ({}) }),
  dagCompleted: Annotation<boolean>({ reducer: (_c, n) => n, default: () => false }),
  loopCount: Annotation<number>({ reducer: (_c, n) => n, default: () => 0 }),
  completedFiles: Annotation<Record<string, FileState>>({ reducer: (_c, n) => n, default: () => ({}) }),
  runtimeState: Annotation<RuntimeState>({ reducer: (_c, n) => n, default: () => RuntimeState.IDLE }),
});

type TaskState = typeof TaskAnnotation.State;
const MAX_LOOP_COUNT = 5;

// ============================================================================
// 节点: Main Agent
// ============================================================================

async function mainAgent(state: TaskState): Promise<Partial<TaskState>> {
  const taskResultCount = Object.keys(state.taskResults).length;
  const fileCount = Object.keys(state.completedFiles).length;
  log.info(`main_agent 进入: dagCompleted=${state.dagCompleted}, taskResults=${taskResultCount}, files=${fileCount}, needDecompose=${state.needDecompose}, finalAnswer.length=${state.finalAnswer.length}`);
  const successN = state.tasks.filter(t=>t.status==="completed").length;
  const failN = state.tasks.filter(t=>t.status==="failed").length;
  const skipN = state.tasks.filter(t=>t.status==="pending").length;
  const logCount = Object.keys(state.taskLogs).filter(k => Number(k) >= 0).length; // 排除 validator 哨兵
  log.info(`  任务明细: 成功=${successN} 失败=${failN} 跳过=${skipN}`);
  log.info(`  状态一致性: results=${taskResultCount} logs=${logCount} completed=${state.completedTasks.length} total=${successN+failN+skipN}`);

  // 一致性断言 — 含差集定位
  const resultIds = new Set(Object.keys(state.taskResults).map(Number));
  const logIds = new Set(Object.keys(state.taskLogs).map(Number).filter(id => id >= 0)); // 排除 validator 哨兵 -1
  const taskIds = new Set(state.tasks.map(t => t.id));
  const consistent = taskIds.size === resultIds.size && logIds.size >= resultIds.size;

  if (taskIds.size !== resultIds.size) {
    const missingTask = [...resultIds].filter(x => !taskIds.has(x));
    const extraTask = [...taskIds].filter(x => !resultIds.has(x));
    log.warn(`不一致: tasks(${taskIds.size}) ≠ results(${resultIds.size}) missingTask=${missingTask.slice(0,5)}${missingTask.length>5?"...":""} extraTask=${extraTask.slice(0,5)}${extraTask.length>5?"...":""}`);
  }
  if (logIds.size < resultIds.size) {
    const missingLog = [...resultIds].filter(x => !logIds.has(x));
    log.warn(`不一致: logs(${logIds.size}) < results(${resultIds.size}) missingLog=${missingLog.slice(0,5)}`);
  }

  // DAG Final Summary — 一眼定位问题
  const dagStart = (state as any)._dagStartMs || 0;
  const duration = dagStart ? ((Date.now() - dagStart) / 1000).toFixed(1) + "s" : "N/A";
  log.info("══════════ DAG FINAL STATE ══════════");
  log.info(`  Tasks:       ${state.tasks.length}`);
  log.info(`  Results:     ${taskResultCount}`);
  log.info(`  Logs:        ${logCount}`);
  log.info(`  Completed:   ${state.completedTasks.length}`);
  log.info(`  Success:     ${successN}`);
  log.info(`  Failed:      ${failN}`);
  log.info(`  Skipped:     ${skipN}`);
  log.info(`  Files:       ${fileCount}`);
  log.info(`  Duration:    ${duration}`);
  log.info(`  Consistency: ${consistent ? "√" : "×"}`);
  log.info("═════════════════════════════════════");

  // 第 1 优先级：DAG 已完成 → 汇总
  if (state.dagCompleted && taskResultCount > 0) {
    transition(state.runtimeState, RuntimeState.SUMMARIZING, "main_agent: DAG已完成→汇总");
    if (!state.needDecompose && state.tasks.length === 0) {
      const raw = Object.values(state.taskResults)[0] || "(无回复)";
      // 尝试提取 summary，避免 raw JSON 透传
      let directAnswer = raw;
      try {
        const j = JSON.parse(raw);
        directAnswer = j.summary || j.sumary || raw;
      } catch { /* not JSON, use raw */ }
      log.info(`main_agent: 简单任务直接输出, 长度=${directAnswer.length}`);
      return { finalAnswer: directAnswer, messages: [new AIMessage(directAnswer)], loopCount: (state.loopCount ?? 0) + 1, runtimeState: RuntimeState.FINISHED };
    }

    log.info("══════ MAIN AGENT 开始汇总 ══════");
    maLog(`══════ 收到 ${taskResultCount} 个任务结果 ══════`);
    events.phase.summarizing();

    // 收集失败任务
    const failedTasks = state.tasks.filter((t) => t.status === "failed");
    const failedNote = failedTasks.length > 0
      ? "\n\n[失败任务]\n" + failedTasks.map((t) => `- #${t.id} ${t.description.slice(0, 80)}: 执行失败，以下成功任务的 summary 中提及此文件不代表已创建`).join("\n")
      : "";

    // 去重：同文件多次修改只保留最新版本
    const fileVersion = new Map<string, { id: string; label: string; text: string; ts: number }>();
    const entries = Object.entries(state.taskResults);

    for (const [id, result] of entries) {
      const task = state.tasks.find((t) => t.id === Number(id));
      const label = task ? task.description : `任务${id}`;
      let parsed: any = null;
      try { parsed = JSON.parse(result); } catch { /* text */ }

      const shortResult = (parsed?.summary || result).replace(/\n/g, " ").slice(0, 150);
      log.info(`  [收] 任务#${id} ${label}: ${shortResult}`);
      maLog(`  [收] #${id} ${label} | ${shortResult}`);

      // 提取文件中涉及的文件，用于去重
      const files = (parsed?.created ?? []).concat(parsed?.modified ?? []);
      // 紧凑格式 — 只保留 summary + files，不传全量结果
      const compactSummary = (parsed?.summary || result).replace(/\n/g, " ").slice(0, 80);
      const status = task?.status === "failed" ? "failed" : "success";
      const text = `[#${id}] ${compactSummary}`;

      // 记录每个文件的最新版本
      for (const f of files) {
        const key = f.toLowerCase().replace(/\\/g, "/");
        const existing = fileVersion.get(key);
        if (!existing || Number(id) > Number(existing.id)) {
          fileVersion.set(key, { id, label, text, ts: Number(id) });
        }
      }
      // 无文件操作的任务直接保留
      if (files.length === 0) {
        fileVersion.set(`_notask_${id}`, { id, label, text, ts: Number(id) });
      }
    }

    // 只保留最新版本
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const [id] of entries) {
      const task = state.tasks.find((t) => t.id === Number(id));
      const files = (() => { try { const j = JSON.parse(state.taskResults[Number(id)]); return (j.created ?? []).concat(j.modified ?? []); } catch { return []; } })();
      const keys: string[] = files.length > 0 ? files.map((f: string) => f.toLowerCase().replace(/\\/g, "/")) : [`_notask_${id}`];
      const latestKeys = keys.map((k: string) => fileVersion.get(k)?.id).filter((v): v is string => !!v);
      if (latestKeys.some((k: string) => k !== id && seen.has(k))) continue;
      const fv = fileVersion.get(keys[0]);
      if (fv) { deduped.push(fv.text); seen.add(fv.id); }
    }

    const summaries = deduped.join("\n\n") || "(无结果)";

    // 统计信息
    const allTasks = state.tasks;
    const successCount = allTasks.filter((t) => t.status === "completed").length;
    const failCount = allTasks.filter((t) => t.status === "failed").length;
    const skipCount = allTasks.filter((t) => t.status === "pending").length;
    const fileCount = Object.keys(state.completedFiles).length;
    const filesSample = Object.keys(state.completedFiles).slice(0, 10).join(", ");
    const stats = [
      `📁 文件: ${fileCount} 个 (${filesSample}${fileCount > 10 ? "..." : ""})`,
      `📋 任务: 成功 ${successCount} · 失败 ${failCount} · 跳过 ${skipCount}`,
    ].join("\n");

    // 小任务量 → 结构化输出，跳过 LLM（省 token）
    let summaryText: string;
    if (deduped.length <= 5) {
      const files = deduped.map((d) => d.replace(/^\[#\d+\]\s*/, "")).filter(Boolean);
      summaryText = files.length > 0
        ? `${stats}\n\n${files.map((f) => `- ${f}`).join("\n")}`
        : `${stats}\n(无产出)`;
      log.info("main_agent: 结构化输出（跳过 LLM）");
    } else {
      const response = await llm.chat(
        [new SystemMessage(MAIN_AGENT_SUMMARY_PROMPT.replace("{userInput}", state.userInput).replace("{tasksSummary}", stats + "\n\n" + summaries + failedNote))],
        { temperature: 0 }
      );
      summaryText = response?.trim() || stats;
      const parsed = safeJsonParse<{ summary?: string }>(summaryText);
      if (parsed?.summary) summaryText = parsed.summary;
    }
    log.info(`  [发] 汇总输出: ${summaryText}`);
    log.info("══════ MAIN AGENT 汇总结束 ══════");
    maLog(`  [发] 汇总: ${summaryText}`);
    maLog("══════ 汇总结束 ══════");
    return {
      finalAnswer: summaryText,
      messages: [new AIMessage(summaryText)],
      loopCount: (state.loopCount ?? 0) + 1,
      runtimeState: RuntimeState.FINISHED,
    };
  }

  // 第 2 优先级：Simple 路径
  if (!state.needDecompose && taskResultCount === 0) {
    const msgs = state.messages;
    const hasAiMsg = msgs.some((m) => m instanceof AIMessage && m.content && !m.tool_calls?.length);
    if (!hasAiMsg && state.finalAnswer === "") {
      log.info("main_agent: 首次入口(简单模式)，透传");
      return { loopCount: (state.loopCount ?? 0) + 1, runtimeState: RuntimeState.IF_PLAN };
    }
    const lastAi = [...msgs].reverse().find((m) => m instanceof AIMessage && m.content);
    if (lastAi) {
      const content = typeof lastAi.content === "string" ? lastAi.content : "";
      log.info(`main_agent: Simple路径, finalAnswer="${content.slice(0, 50)}"`);
      return { finalAnswer: content || "(无内容)", loopCount: (state.loopCount ?? 0) + 1, runtimeState: RuntimeState.FINISHED };
    }
    log.info("main_agent: Simple路径, 无AI消息");
    return { loopCount: (state.loopCount ?? 0) + 1, runtimeState: RuntimeState.IF_PLAN };
  }

  // 第 3 优先级：等待 DAG
  log.info("main_agent: 等待 DAG 执行，透传");
  return { loopCount: (state.loopCount ?? 0) + 1 };
}

// ============================================================================
// 节点: IFPlan / Planner / DAGScheduler / SimpleWorker
// ============================================================================

async function ifPlan(state: TaskState): Promise<Partial<TaskState>> {
  const history = (state as any)._shortTermContext || "";

  log.info(`if_plan: LLM 判断复杂度`);
  const response = await llm.chat(
    [new HumanMessage(IF_PLAN_PROMPT.replace("{userInput}", state.userInput).replace("{history}", history))],
    { temperature: 0 }
  );
  try {
    const json = JSON.parse(response.trim());
    const workspace = json.workspace && json.workspace !== "." ? json.workspace : "";
    const nextState = json.needDecompose === true ? RuntimeState.PLANNING : RuntimeState.EXECUTING;
    log.info(`[ifPlan] needDecompose=${json.needDecompose} reason=${json.reason || "?"} workspace=${json.workspace || "."}`);
    transition(state.runtimeState, nextState, `if_plan: ${json.needDecompose ? "planner" : "simple_worker"}`);
    return { needDecompose: json.needDecompose === true, workspace, runtimeState: nextState };
  } catch {
    transition(state.runtimeState, RuntimeState.EXECUTING, "if_plan: parse失败→simple_worker");
    return { needDecompose: false, runtimeState: RuntimeState.EXECUTING };
  }
}

async function planner(state: TaskState): Promise<Partial<TaskState>> {
  events.phase.planning();
  try {
    // 自动检索匹配的技能模板
    const matchedSkills = await searchSkills(state.userInput);
    let skillContext = "";
    if (matchedSkills.length > 0) {
      skillContext = "\n\n📚 匹配的技能知识 — 必须严格遵循以下结构和依赖:\n\n" +
        matchedSkills.map((s) => `### ${s.title}\n${s.content}`).join("\n\n---\n\n");
      log.info(`planner: 注入 ${matchedSkills.length} 个技能知识 (${matchedSkills.map(s => s.name).join(", ")})`);
    }

    const shortCtx = (state as any)._shortTermContext || "";
    const prompt = PLANNER_PROMPT
      .replace("{userInput}", `${shortCtx ? `对话历史(仅供参考):\n${shortCtx}\n\n当前请求: ` : ""}${state.userInput}`)
      .replace("{skills}", skillContext)
      .replace("{workspace}", state.workspace || process.env.TAICODE_CWD || process.cwd());
    const response = await reactAgent(
      "你是项目规划专家。用 ls/read_file 观察项目，再输出 JSON。",
      prompt,
      8,
    );
    const json = extractJson(response);
    const parsed = safeJsonParse<{ spec?: string[]; contract?: Record<string, number>; files?: string[]; bigTasks?: { id: number; goal: string; files?: string[] }[] }>(json);

    if (parsed?.bigTasks && parsed.bigTasks.length > 0) {
      const bigTasks: SubTask[] = parsed.bigTasks.map((t, i) => ({
        id: i + 1,
        description: t.goal,
        status: "pending" as const,
        result: "",
      }));
      // 大任务串行队列
      const deps: Record<string, number[]> = {};
      for (let i = 1; i < bigTasks.length; i++) {
        deps[String(bigTasks[i].id)] = [bigTasks[i - 1].id];
      }
      log.info(`planner: ${bigTasks.length} 个大任务 → 队列串行`);
      events.planner.plan(bigTasks.length, bigTasks.length, 1);
      // 落盘 spec.json 到 .TAI/，Worker 共享
      try {
        const ws = state.workspace || process.env.TAICODE_CWD || process.cwd();
        const taiDir = path.join(ws, ".TAI");
        if (!fs.existsSync(taiDir)) fs.mkdirSync(taiDir, { recursive: true });
        const specPath = path.join(taiDir, "spec.json");
        fs.writeFileSync(specPath, JSON.stringify({ spec: parsed.spec ?? [], contract: parsed.contract ?? {}, files: parsed.files ?? [], workspace: ws }, null, 2), "utf-8");
        log.info(`spec.json 已落盘: ${specPath}`);
      } catch { /* ignore */ }
      const specFiles = parsed.files || [];
      if (specFiles.length > 0) log.info(`specFiles: ${specFiles.length} 个文件 → ${specFiles.slice(0, 10).join(", ")}`);
      transition(state.runtimeState, RuntimeState.SPLITTING, "planner: 输出bigTasks");
      return { spec: parsed.spec ?? [], specFiles, contract: parsed.contract ?? {}, bigTasks, tasks: bigTasks, dependencies: deps, bigTaskIndex: 0, runtimeState: RuntimeState.SPLITTING };
    }
  } catch (e) {
    log.warn("Planner 解析失败，回退为单任务:", e);
  }
  transition(state.runtimeState, RuntimeState.SPLITTING, "planner: 回退单任务");
  return { tasks: [{ id: 1, description: state.userInput, status: "pending", result: "" }], dependencies: {}, runtimeState: RuntimeState.SPLITTING };
}

// ============================================================================
// Task Splitter — 大任务拆小任务
// ============================================================================

async function taskSplitter(state: TaskState): Promise<Partial<TaskState>> {
  const bigTasks = state.bigTasks;
  const idx = state.bigTaskIndex;
  if (bigTasks.length === 0 || idx >= bigTasks.length) return {};

  const bigTask = bigTasks[idx];
  log.info(`taskSplitter: 大任务#${bigTask.id} "${bigTask.description.slice(0, 50)}" (${idx + 1}/${bigTasks.length})`);
  events.phase.running(); // 触发 TUI 切换为 running 状态
  events.bigtask.start(idx + 1, bigTasks.length, bigTask.description);

  // 已完成大任务的上下文
  const ctx = Object.entries(state.taskResults)
    .map(([id, r]) => {
      try { const j = JSON.parse(r); return `[#${id}] ${j.summary || r.slice(0, 200)}`; }
      catch { return `[#${id}] ${r.slice(0, 200)}`; }
    })
    .join("\n");

  // 已完成文件清单 → 禁止重复创建
  const fileEntries = Object.entries(state.completedFiles);
  const completedStr = fileEntries.length > 0
    ? `\n已完成文件（禁止重复创建，如需修改请说明"修改"）:\n${fileEntries.map(([name, fs]) => `- ${name} (${fs.lastAction} by Task#${fs.lastTaskId})`).join("\n")}`
    : "\n已完成文件: （无）";

  const prompt = TASK_SPLITTER_PROMPT
    .replace("{userRequest}", state.userInput.slice(0, 500))
    .replace("{spec}", JSON.stringify(state.spec ?? {}).slice(0, 300) || "无")
    .replace("{bigTask}", bigTask.description.slice(0, 800))
    .replace("{context}", (ctx || "(无)").slice(0, 500))
    .replace("{completedFiles}", completedStr);

  try {
    const response = await reactAgent(
      "你是任务拆分专家。用 ls/read_file 观察项目文件，再输出 JSON。",
      prompt,
      8,
    );
    const json = extractJson(response);
    const parsed = safeJsonParse<{
      smallTasks?: { id: number; description: string }[];
      dependencies?: Record<string, unknown>;
    }>(json);

    if (parsed?.smallTasks?.length) {
      let rawTasks = parsed.smallTasks.map((st) => ({
        id: Number(st.id), description: st.description, status: "pending" as const, result: "",
        contract: state.contract,
      }));

      // 同文件合并：多个小任务描述指向同一文件 → 合为一个
      const merged: typeof rawTasks = [];
      const fileOwners = new Map<string, number>(); // 文件名 → 合并后的索引
      for (const t of rawTasks) {
        const files = t.description.match(/([a-zA-Z0-9_-]+\.[a-z]{1,6})/gi) ?? [];
        let ownerIdx = -1;
        for (const f of files) {
          const k = f.toLowerCase();
          if (fileOwners.has(k)) { ownerIdx = fileOwners.get(k)!; break; }
        }
        if (ownerIdx >= 0) {
          // 合并到已有任务
          merged[ownerIdx].description += "; " + t.description;
        } else {
          const idx = merged.length;
          merged.push(t);
          for (const f of files) fileOwners.set(f.toLowerCase(), idx);
        }
      }

      // 🔧 代码层去重 — 过滤已有文件的 create 任务（不靠 LLM，硬兜底）
      const skipped: string[] = [];
      const filtered = merged.filter((t) => {
        const isCreate = /创建|新建|create|mkdir/i.test(t.description);
        if (!isCreate) return true; // 修改类任务不过滤
        const taskFiles = t.description.match(/([a-zA-Z0-9_-]+\.[a-z]{1,6})/gi) ?? [];
        if (taskFiles.length === 0) return true; // 无明确文件名的任务不过滤
        const allExist = taskFiles.every((f) => state.completedFiles[f.toLowerCase()]);
        if (allExist) {
          skipped.push(taskFiles.join(","));
          return false;
        }
        return true;
      });
      if (skipped.length > 0) log.info(`代码层跳过 ${skipped.length} 个重复创建: ${skipped.join("; ")}`);

      const deps = normalizeDependencies(parsed.dependencies ?? {});
      const note = merged.length < rawTasks.length ? ` (合并前${rawTasks.length}个)` : "";
      log.info(`taskSplitter: → ${filtered.length} 个小任务${note}${skipped.length > 0 ? ` (跳过${skipped.length}个已有文件)` : ""}`);
      transition(state.runtimeState, RuntimeState.EXECUTING, "taskSplitter: 拆分完成");
      return { tasks: filtered, dependencies: deps, runtimeState: RuntimeState.EXECUTING };
    }
  } catch (e) {
    log.warn("TaskSplitter 失败:", e);
  }

  transition(state.runtimeState, RuntimeState.EXECUTING, "taskSplitter: 回退单任务");
  return { tasks: [{ id: 1, description: bigTask.description, status: "pending", result: "", contract: state.contract }], dependencies: {}, runtimeState: RuntimeState.EXECUTING };
}

async function dagSchedulerNode(state: TaskState): Promise<Partial<TaskState>> {
  events.phase.running();
  const tasks = state.tasks.map((t) => ({ ...t, status: "pending" as const }));
  const result = await dagScheduler.execute(tasks, state.dependencies);
  events.phase.validating();

  // 提取已完成文件 → Planner 去重（含 FileState 追溯）
  const completedFiles = { ...state.completedFiles };
  const ws = (process.env.TAICODE_CWD ?? process.cwd()).replace(/\\/g, "/").toLowerCase();
  const now = Date.now();
  let addedCount = 0;
  const relPath = (abs: string): string => {
    let normalized = abs.replace(/\\/g, "/").toLowerCase();
    // 去掉 ./ 前缀
    if (normalized.startsWith("./")) normalized = normalized.slice(2);
    if (normalized.startsWith(ws)) return normalized.slice(ws.length).replace(/^\//, "");
    return normalized; // fallback: 保留完整路径
  };
  for (const [idStr, r] of Object.entries(result.taskResults)) {
    const taskId = Number(idStr);
    const task = result.tasks.find(t => t.id === taskId);
    if (task?.status !== "completed") continue;
    try {
      const j = JSON.parse(r);
      if (j.status === "success") {
        for (const f of (j.created ?? [])) {
          const key = relPath(f);
          if (key && key.length < 200 && !completedFiles[key]) {
            completedFiles[key] = { created: true, lastTaskId: taskId, lastAction: "create", modifiedAt: now };
            addedCount++;
          }
        }
        for (const f of (j.modified ?? [])) {
          const key = relPath(f);
          if (key && key.length < 200) {
            completedFiles[key] = { created: true, lastTaskId: taskId, lastAction: "modify", modifiedAt: now };
            addedCount++;
          }
        }
      }
    } catch { /* 非 JSON 结果跳过 */ }
  }
  if (addedCount > 0) log.info(`completedFiles +${addedCount}, 总计 ${Object.keys(completedFiles).length} 个`);

  // 回填 writes — 从 Worker JSON 结果提取实际产出文件，供 Validator Spec Lock 使用
  for (const t of result.tasks) {
    if (t.status === "completed") {
      const r = result.taskResults[t.id];
      if (r) {
        try {
          const j = JSON.parse(r);
          t.writes = [...(j.created ?? []), ...(j.modified ?? [])];
        } catch { /* ignore */ }
      }
    }
  }

  transition(state.runtimeState, RuntimeState.VALIDATING, "dagScheduler: 执行完成");

  // === 全局 ID 空间 — 跨 DAG 批次统一 remap ===
  function remapBatch(
    tasks: SubTask[],
    results: Record<number, string>,
    logs: Record<number, string[]>,
    completed: number[],
    prevResults: Record<number, string>,
  ) {
    const idOffset = Object.keys(prevResults).length;
    const idMap = new Map<number, number>();
    for (const t of tasks) idMap.set(t.id, t.id + idOffset);

    const remappedTasks = tasks.map((t) => ({
      ...t,
      id: idMap.get(t.id)!,
      ...((t as any).deps ? { deps: (t as any).deps.map((d: number) => idMap.get(d) ?? d) } : {}),
    }));

    const mergedResults = { ...prevResults };
    const mergedLogs: Record<number, string[]> = {};
    for (const [id, r] of Object.entries(results)) {
      const gid = idMap.get(Number(id)) ?? Number(id);
      mergedResults[gid] = r;
      if (logs[Number(id)]) mergedLogs[gid] = logs[Number(id)];
    }
    const mergedCompleted = [...completed.map((id) => idMap.get(id) ?? id)];

    return { tasks: remappedTasks, results: mergedResults, logs: mergedLogs, completed: mergedCompleted, idMap };
  }

  const batch = remapBatch(result.tasks, result.taskResults, result.taskLogs, result.completedTasks, state.taskResults);
  const allTaskResults = batch.results;
  const allTaskLogs = { ...state.taskLogs, ...batch.logs };
  const allCompleted = [...state.completedTasks, ...batch.completed];

  log.info(`DAG 合并: +${batch.completed.length} → results=${Object.keys(allTaskResults).length} files=${Object.keys(completedFiles).length}`);

  return {
    tasks: [...state.tasks, ...batch.tasks], completedTasks: allCompleted,
    taskResults: allTaskResults, taskLogs: allTaskLogs,
    dagCompleted: true, needDecompose: false,
    completedFiles, runtimeState: RuntimeState.VALIDATING,
  };
}

/** Validator — DAG 完成后递归验证+修复, 最多 3 轮 */
async function validatorNode(state: TaskState): Promise<Partial<TaskState>> {
  // 标记当前大任务完成，准备下一个
  const nextIdx = state.bigTaskIndex + 1;
  log.info(`validator: 大任务 ${nextIdx}/${state.bigTasks.length} 完成`);

  const rootTask = state.tasks.find((t) => t.writes?.some((w) => w.endsWith("/")));
  const projectDir = rootTask?.writes?.find((w) => w.endsWith("/")) ?? ".";
  const maxRetries = 3;

  const validationLogs: string[] = [];
  let totalFixes = 0;

  for (let round = 1; round <= maxRetries; round++) {
    const report = await validateProject(state.tasks, projectDir);
    if (report.allClean) {
      if (round === 1) {
        log.info(`验证通过: ${projectDir} 项目结构完整`);
      } else {
        log.info(`验证通过 (第${round}轮): ${totalFixes} 个问题已自动修复`);
      }
      break;
    }

    log.warn(`验证第${round}轮: 发现 ${report.issues.length} 个问题`);
    for (const issue of report.issues) {
      log.warn(`  [${issue.type}] ${issue.message}`);
      validationLogs.push(`[验证] [${issue.type}] ${issue.message}`);
    }

    const fixes = await autoFix(report.issues);
    if (fixes.length === 0) {
      log.warn(`  无可自动修复的问题, 停止验证`);
      break;
    }

    for (const fix of fixes) {
      log.info(`  修复: ${fix}`);
      validationLogs.push(`  修复: ${fix}`);
    }
    totalFixes += fixes.length;
  }

  const taskLogs = { ...state.taskLogs };
  const vKey = -1;
  taskLogs[vKey] = validationLogs;
  return { taskLogs, bigTaskIndex: nextIdx, runtimeState: RuntimeState.VALIDATING };
}

async function simpleWorker(state: TaskState): Promise<Partial<TaskState>> {
  const shortCtx = (state as any)._shortTermContext || "";
  const desc = shortCtx ? `对话历史(仅供参考):\n${shortCtx}\n\n当前任务: ${state.userInput}` : state.userInput;
  const task: SubTask = { id: 0, description: desc, status: "in_progress", result: "" };
  const result = await reactWorker(task, 0);
  const response = result.error ? `执行出现问题: ${result.error}\n\n${result.result}` : result.result;
  transition(state.runtimeState, RuntimeState.SUMMARIZING, "simpleWorker: 执行完成");
  return {
    messages: [new AIMessage(response)], taskResults: { 0: response },
    taskLogs: { 0: result.logs }, dagCompleted: true, needDecompose: false,
    runtimeState: RuntimeState.SUMMARIZING,
  };
}

// ============================================================================
// 路由 — 显式状态机统一管理，替代分散的 router 函数
// ============================================================================

function unifiedRouter(state: TaskState, fromNode: string): string {
  const nextCount = (state.loopCount ?? 0) + 1;

  // 死循环保护 (最高优先级)
  if (nextCount > MAX_LOOP_COUNT) {
    log.error(`死循环保护! loopCount=${nextCount}`);
    return END;
  }

  // main_agent 节点的路由逻辑
  if (fromNode === "main_agent") {
    if (state.dagCompleted) {
      log.info("router → END (dagCompleted)");
      return END;
    }
    const hasAnswer = !!state.finalAnswer && state.finalAnswer.trim().length > 0;
    if (hasAnswer) {
      log.info("router → END (有finalAnswer)");
      return END;
    }
    log.info(`router → if_plan (loopCount=${nextCount})`);
    return "if_plan";
  }

  // if_plan 节点: needDecompose → planner, else → simple_worker
  if (fromNode === "if_plan") {
    const next = state.needDecompose ? "planner" : "simple_worker";
    transition(state.runtimeState, state.needDecompose ? RuntimeState.PLANNING : RuntimeState.EXECUTING, `router: if_plan→${next}`);
    return next;
  }

  // simple_worker 之后: 有 tasks → dag_scheduler, else → main_agent
  if (fromNode === "simple_worker") {
    if (state.needDecompose && state.tasks.length > 0) return "dag_scheduler";
    return "main_agent";
  }

  // validator 之后: 还有大任务 → task_splitter, 没有 → main_agent(summary)
  if (fromNode === "validator") {
    const idx = state.bigTaskIndex + 1;
    if (state.bigTasks.length > 0 && idx < state.bigTasks.length) {
      transition(state.runtimeState, RuntimeState.SPLITTING, "router: validator→task_splitter(更多大任务)");
      return "task_splitter";
    }
    transition(state.runtimeState, RuntimeState.SUMMARIZING, "router: validator→main_agent(汇总)");
    return "main_agent";
  }

  // 默认
  return END;
}

// ============================================================================
// 编译图
// ============================================================================

const TaskGraph = new StateGraph(TaskAnnotation)
  .addNode("main_agent", mainAgent)
  .addNode("if_plan", ifPlan)
  .addNode("planner", planner)
  .addNode("task_splitter", taskSplitter)
  .addNode("dag_scheduler", dagSchedulerNode)
  .addNode("validator", validatorNode)
  .addNode("simple_worker", simpleWorker)
  .addEdge(START, "main_agent")
  .addConditionalEdges("main_agent", (s) => unifiedRouter(s, "main_agent"), { if_plan: "if_plan", [END]: END })
  .addConditionalEdges("if_plan", (s) => unifiedRouter(s, "if_plan"), { planner: "planner", simple_worker: "simple_worker" })
  .addEdge("planner", "task_splitter")
  .addEdge("task_splitter", "dag_scheduler")
  .addEdge("dag_scheduler", "validator")
  .addConditionalEdges("validator", (s) => unifiedRouter(s, "validator"), { task_splitter: "task_splitter", main_agent: "main_agent" })
  .addConditionalEdges("simple_worker", (s) => unifiedRouter(s, "simple_worker"), { dag_scheduler: "dag_scheduler", main_agent: "main_agent" })
  .compile();

// ============================================================================
// 公开 API
// ============================================================================

export async function runTask(userInput: string, shortTermContext?: string): Promise<string> {
  const initialState = {
    _shortTermContext: shortTermContext,
    messages: [new HumanMessage(userInput)], userInput,
    needDecompose: false, tasks: [] as SubTask[],
    dependencies: {} as Record<string, number[]>,
    completedTasks: [] as number[], taskResults: {} as Record<number, string>,
    taskLogs: {} as Record<number, string[]>,
    finalAnswer: "", dagCompleted: false, loopCount: 0,
    _dagStartMs: Date.now(),
    bigTaskIndex: 0, bigTasks: [] as SubTask[],
    workspace: process.env.TAICODE_CWD ?? process.cwd(),
    spec: [] as string[], specFiles: [] as string[], completedFiles: {} as Record<string, FileState>,
    runtimeState: RuntimeState.IDLE,
  };
  const result = await TaskGraph.invoke(initialState);
  events.phase.done();
  return result.finalAnswer || "(未生成回复)";
}
