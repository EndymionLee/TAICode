/**
 * State Layer — 结构化状态 + FrameScheduler 批量提交
 *
 * 三层架构:
 *   EventBus (events.ts) → State (本文件) → FrameScheduler → React
 *
 * 设计:
 *   - 保留 lines[] 用于聊天消息渲染 (向后兼容)
 *   - 新增 status / activeTasks / completedTasks 结构化状态
 *   - 所有 React 通知通过 FrameScheduler 16ms 批量合并
 *   - getState() / subscribe() 签名不变
 */
import { bus } from "../core/events.js";
import { frameScheduler } from "./frame-scheduler.js";
import { createLogger } from "../core/logger.js";

const d = (raw: any) => raw?.data ?? raw;

// ============================================================================
// 类型定义
// ============================================================================

export type LineKind = "user" | "assistant" | "thought" | "info";
export interface Line { id: number; text: string; kind: LineKind }

export interface ActiveTask {
  id: number;
  description: string;
  spinnerIdx: number;
}

export interface CompletedTask {
  id: number;
  description: string;
  status: "completed" | "failed";
}

export interface BigTaskInfo {
  current: number;
  total: number;
  goal: string;
}

export interface ConfirmRequest {
  message: string;
  resolve: (ok: boolean) => void;
}

export interface TaskStats {
  success: number;
  failed: number;
  skipped: number;
}

export interface AppState {
  // 聊天消息
  lines: Line[];

  // 结构化状态
  status: "idle" | "thinking" | "planning" | "running" | "validating" | "summarizing";
  activeTasks: Map<number, ActiveTask>;
  completedTasks: Map<number, CompletedTask>;
  taskStats: TaskStats;
  bigTask: BigTaskInfo | null;
  pendingConfirm: ConfirmRequest | null;
  phaseStartTime: number;

  // 内部 (不暴露给组件)
  listeners: Set<() => void>;
}

// ============================================================================
// 全局状态
// ============================================================================

let _lid = 0;

const state: AppState = {
  lines: [],

  status: "idle",
  activeTasks: new Map(),
  completedTasks: new Map(),
  taskStats: { success: 0, failed: 0, skipped: 0 },
  bigTask: null,
  pendingConfirm: null,
  phaseStartTime: 0,

  listeners: new Set(),
};

export function getState() { return state; }

/**
 * 订阅状态变更。回调通过 FrameScheduler 批量调用，16ms 内多次变更合并为一次。
 * 返回取消函数，签名不变。
 */
export function subscribe(fn: () => void) {
  return frameScheduler.onFlush(fn);
}

const log = createLogger("tui:confirm");
let _autoApprove = false;
export function toggleAutoApprove(): boolean {
  _autoApprove = !_autoApprove;
  return _autoApprove;
}
export function isAutoApprove(): boolean { return _autoApprove; }

/** 弹出确认框，开了自动放行直接返回 true */
export function requestConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (_autoApprove) {
      log.info(`自动放行: ${message}`);
      resolve(true);
      return;
    }
    state.pendingConfirm = {
      message,
      resolve: (ok: boolean) => { state.pendingConfirm = null; resolve(ok); },
    };
    frameScheduler.flushNow();
  });
}

/** 注入系统欢迎消息 (TUI 启动时调用) */
export function pushWelcome(lines: string[]): void {
  for (const text of lines) {
    state.lines.push({ id: ++_lid, text, kind: "info" as const });
  }
  if (state.lines.length > 200) state.lines = state.lines.slice(-200);
}

// ============================================================================
// 文本行操作 (向后兼容)
// ============================================================================

function push(lines: Line[]) {
  state.lines.push(...lines);
  if (state.lines.length > 200) state.lines = state.lines.slice(-200);
}

function pushOne(text: string, kind: LineKind) {
  state.lines.push({ id: ++_lid, text, kind });
  if (state.lines.length > 200) state.lines = state.lines.slice(-200);
}

// ============================================================================
// 结构化状态操作
// ============================================================================

function setStatus(s: AppState["status"]) {
  state.status = s;
  state.phaseStartTime = Date.now();
}

function addActiveTask(id: number, description: string) {
  state.activeTasks.set(id, { id, description: description.slice(0, 50), spinnerIdx: 0 });
}

function markTaskCompleted(id: number, error?: string) {
  const t = state.activeTasks.get(id);
  state.activeTasks.delete(id);
  if (t) {
    state.completedTasks.set(id, {
      id, description: t.description,
      status: error ? "failed" : "completed",
    });
  }
}

// ============================================================================
// 定时器引用
// ============================================================================

let t0 = 0;
let streamStart = 0;
let dotInterval: ReturnType<typeof setInterval> | null = null;
const TASK_SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
let taskDotInterval: ReturnType<typeof setInterval> | null = null;
let taskSpinIdx = 0;

// ============================================================================
// 事件订阅 (initState)
// ============================================================================

export function initState() {
  // ── Chat 事件 ──
  bus.on("chat:user", (raw: any) => {
    t0 = Date.now();
    pushOne(`❯ ${d(raw).text ?? raw?.text}`, "user");
    pushOne("", "user");
    frameScheduler.flushNow();
  });

  // ── LLM 思考 ──
  bus.on("llm:start", () => {
    streamStart = Date.now();
    setStatus("thinking");
    const thoughtId = ++_lid;
    push([
      { id: thoughtId, text: `  Thought for .`, kind: "thought" as const },
      { id: ++_lid, text: "", kind: "assistant" as const },
      { id: ++_lid, text: "● ", kind: "assistant" as const },
    ]);
    frameScheduler.requestFlush();
    let dots = 1;
    dotInterval = setInterval(() => {
      dots = (dots % 3) + 1;
      const line = state.lines.find((l) => l.id === thoughtId);
      if (line) line.text = `  Thought for ${".".repeat(dots)}`;
      frameScheduler.requestFlush();
    }, 300);
  });

  bus.on("llm:token", (raw: any) => {
    const t = d(raw).text ?? "";
    if (!t) return;
    const parts = t.split("\n");
    const last = state.lines[state.lines.length - 1];
    if (last) last.text += parts[0]; // 追加到当前行 (已由 llm:start 以 "● " 开头)
    // 续行不加 ● 前缀
    for (let i = 1; i < parts.length; i++) pushOne(parts[i], "assistant");
    frameScheduler.requestFlush();
  });

  bus.on("llm:done", () => {
    if (dotInterval) { clearInterval(dotInterval); dotInterval = null; }
    const ts = ((Date.now() - streamStart) / 1000).toFixed(0);
    const total = t0 ? ((Date.now() - t0) / 1000).toFixed(0) : "?";
    for (const l of state.lines) {
      if (l.text.startsWith("  Thought for .")) l.text = `  Thought for ${ts}s`;
    }
    pushOne("", "info");
    pushOne(`✻ Crunched for ${total}s`, "thought");
    pushOne("", "info");
    if (state.status === "thinking") setStatus("idle");
    frameScheduler.requestFlush();
  });

  // ── DAG 调度 ──
  bus.on("dag:start", (raw: any) => {
    setStatus("running");
    state.taskStats = { success: 0, failed: 0, skipped: 0 };
    state.activeTasks.clear();
    state.completedTasks.clear();
    // 不再向 lines[] push "Running..." — StatusBar 负责显示
    // 仅保留 activeTasks spinner 定时器 (每 120ms 旋转)
    taskDotInterval = setInterval(() => {
      taskSpinIdx = (taskSpinIdx + 1) % TASK_SPINNER.length;
      for (const [, t] of state.activeTasks) {
        t.spinnerIdx = taskSpinIdx;
      }
      frameScheduler.requestFlush();
    }, 120);
    frameScheduler.requestFlush();
  });

  bus.on("dag:done", (raw: any) => {
    if (taskDotInterval) { clearInterval(taskDotInterval); taskDotInterval = null; }
    state.taskStats = {
      success: d(raw).success ?? 0,
      failed: d(raw).failed ?? 0,
      skipped: d(raw).skipped ?? 0,
    };
    // DAG 结束立即清空任务列表，不残留
    state.activeTasks.clear();
    state.completedTasks.clear();
    state.bigTask = null;
    frameScheduler.requestFlush();
  });

  // ── 任务事件 (仅更新结构化状态，不向 lines[] push — TaskList 负责渲染) ──
  bus.on("task:start", (raw: any) => {
    const id = d(raw).id as number;
    const desc = (d(raw).description as string)?.slice(0, 50) ?? "";
    addActiveTask(id, desc);
    frameScheduler.requestFlush();
  });

  bus.on("task:done", (raw: any) => {
    const id = d(raw).id as number;
    markTaskCompleted(id);
    frameScheduler.requestFlush();
  });

  bus.on("task:fail", (raw: any) => {
    const id = d(raw).id as number;
    markTaskCompleted(id, d(raw).error ?? "未知错误");
    frameScheduler.requestFlush();
  });

  // ── BigTask 进度 ──
  bus.on("bigtask:start", (raw: any) => {
    state.bigTask = { current: d(raw).current, total: d(raw).total, goal: d(raw).goal };
    frameScheduler.requestFlush();
  });

  // ── Phase 生命周期 ──
  bus.on("phase:change", (raw: any) => {
    const phase = d(raw).phase as AppState["status"];
    if (phase === "idle") {
      setStatus("idle");
      state.activeTasks.clear();
      state.completedTasks.clear();
    } else if (phase === "summarizing") {
      setStatus("summarizing");
      state.completedTasks.clear(); // LLM 汇总开始时清空已完成任务，避免和回复混在一起
    } else {
      setStatus(phase);
    }
    frameScheduler.requestFlush();
  });

  // ── 聊天回复 ──
  bus.on("chat:assistant", (raw: any) => {
    const text = (d(raw).text as string) ?? "";
    const lines = text.split("\n");
    pushOne(`● ${lines[0]}`, "assistant");
    for (let i = 1; i < lines.length; i++) pushOne(lines[i], "assistant");
    pushOne("", "info"); // 回复后空一行，与下次消息分隔
    frameScheduler.requestFlush();
  });

}
