/**
 * EventBus — Runtime 与 Renderer 的唯一通信信道
 *
 * 原则:
 *   1. Runtime 不知道终端存在, 只 emit 事件
 *   2. Renderer 不知道 Agent 存在, 只 subscribe 事件
 *   3. 后续加 WebUI/TUI/VSCode 插件只需换 Renderer
 */
import Emittery from "emittery";

// ============================================================================
// EventBus 包装器
// ============================================================================

class EventBus {
  private bus = new Emittery();

  emit<E extends keyof EventMap>(event: E, data: EventMap[E] extends void ? undefined : EventMap[E]): void {
    void this.bus.emit(event as string, data);
  }

  on<E extends keyof EventMap>(event: E, handler: (data: EventMap[E]) => void | Promise<void>): void {
    this.bus.on(event as string, handler as any);
  }

  off<E extends keyof EventMap>(event: E, handler: (data: EventMap[E]) => void | Promise<void>): void {
    this.bus.off(event as string, handler as any);
  }
}

export const bus = new EventBus();

// ============================================================================
// 事件类型定义
// ============================================================================

export interface EventMap {
  // Session
  "session:start": { model: string };
  "session:end": void;

  // Chat
  "chat:user": { text: string };
  "chat:assistant": { text: string };
  "llm:start": { id: string };
  "llm:token": { id: string; text: string };
  "llm:done": { id: string; response: string };

  // Memory
  "memory:loaded": { shortTerm: number; semantic: number; persona: string };
  "memory:saved": { shortTerm: number; semantic: number; persona: string };

  // Planner
  "planner:start": void;
  "planner:plan": { taskCount: number; groups: number; roots: number };
  "planner:done": void;

  // DAG
  "dag:start": { taskCount: number; maxWorkers: number };
  "dag:done": { success: number; failed: number; skipped: number };

  // Task
  "task:start": { id: number; description: string };
  "task:done": { id: number; result: string };
  "task:fail": { id: number; error: string };
  "task:result": { response: string; duration: number };
  "task:progress": { id: number; step: number; status: string };

  // Session control
  "session:interrupt": void;

  // Worker
  "worker:start": { id: number; description: string };
  "worker:tool": { id: number; name: string };
  "worker:done": { id: number };

  // Tool
  "tool:call": { name: string; args: Record<string, unknown> };
  "tool:result": { name: string; result: string; duration: number };

  // Validator
  "validator:start": void;
  "validator:issue": { type: string; message: string };
  "validator:fix": { description: string };
  "validator:done": { issues: number };

  // BigTask
  "bigtask:start": { current: number; total: number; goal: string };

  // Phase lifecycle
  "phase:change": { phase: "idle" | "planning" | "running" | "validating" | "summarizing" };

  // Command (PowerShell Tool)
  "command:start": { command: string; cwd: string };
  "command:token": { text: string; stream: "stdout" | "stderr" };
  "command:finish": { result: import("./tools/powershell/command-types.js").CommandResult };
  "command:error": { command: string; error: string };

  // Approval
  "approval:request": { action: string; path: string };
  "approval:granted": { action: string; path: string };
  "approval:denied": { action: string; path: string };

  "log": { level: string; msg: string; time: number };
}

// ============================================================================
// 类型安全的辅助函数 (推荐用这种方式 emit)
// ============================================================================

let _cid = 0;
function nextId(): string { return `llm-${++_cid}`; }

export const events = {
  session: {
    start(model: string) { bus.emit("session:start", { model }); },
    end() { bus.emit("session:end", undefined!); },
    interrupt() { bus.emit("session:interrupt", undefined!); },
  },
  chat: {
    user(text: string) { bus.emit("chat:user", { text }); },
    assistant(text: string) { bus.emit("chat:assistant", { text }); },
  },
  llm: {
    start() { const id = nextId(); bus.emit("llm:start", { id }); return id; },
    token(id: string, text: string) { bus.emit("llm:token", { id, text }); },
    done(id: string, response: string) { bus.emit("llm:done", { id, response }); },
  },
  memory: {
    loaded(stm: number, sem: number, persona: string) { bus.emit("memory:loaded", { shortTerm: stm, semantic: sem, persona }); },
    saved(stm: number, sem: number, persona: string) { bus.emit("memory:saved", { shortTerm: stm, semantic: sem, persona }); },
  },
  planner: {
    start() { bus.emit("planner:start", undefined!); },
    plan(taskCount: number, groups: number, roots: number) { bus.emit("planner:plan", { taskCount, groups, roots }); },
  },
  dag: {
    start(taskCount: number, maxWorkers: number) { bus.emit("dag:start", { taskCount, maxWorkers }); },
    done(success: number, failed: number, skipped: number) { bus.emit("dag:done", { success, failed, skipped }); },
  },
  task: {
    start(id: number, description: string) { bus.emit("task:start", { id, description }); },
    done(id: number, result: string) { bus.emit("task:done", { id, result }); },
    fail(id: number, error: string) { bus.emit("task:fail", { id, error }); },
    result(response: string, duration: number) { bus.emit("task:result", { response, duration }); },
    progress(id: number, step: number, status: string) { bus.emit("task:progress", { id, step, status }); },
  },
  worker: {
    start(id: number, description: string) { bus.emit("worker:start", { id, description }); },
    tool(id: number, name: string) { bus.emit("worker:tool", { id, name }); },
    done(id: number) { bus.emit("worker:done", { id }); },
  },
  tool: {
    call(name: string, args: Record<string, unknown>) { bus.emit("tool:call", { name, args }); },
    result(name: string, result: string, duration: number) { bus.emit("tool:result", { name, result, duration }); },
  },
  validator: {
    start() { bus.emit("validator:start", undefined!); },
    issue(type: string, message: string) { bus.emit("validator:issue", { type, message }); },
    fix(description: string) { bus.emit("validator:fix", { description }); },
    done(issues: number) { bus.emit("validator:done", { issues }); },
  },
  bigtask: {
    start(current: number, total: number, goal: string) { bus.emit("bigtask:start", { current, total, goal }); },
  },
  phase: {
    planning() { bus.emit("phase:change", { phase: "planning" }); },
    running() { bus.emit("phase:change", { phase: "running" }); },
    validating() { bus.emit("phase:change", { phase: "validating" }); },
    summarizing() { bus.emit("phase:change", { phase: "summarizing" }); },
    done() { bus.emit("phase:change", { phase: "idle" }); },
  },
  command: {
    start(command: string, cwd: string) { bus.emit("command:start", { command, cwd }); },
    token(text: string, stream: "stdout" | "stderr") { bus.emit("command:token", { text, stream }); },
    finish(result: import("./tools/powershell/command-types.js").CommandResult) { bus.emit("command:finish", { result }); },
    error(command: string, error: string) { bus.emit("command:error", { command, error }); },
  },
  approval: {
    request(action: string, path: string) { bus.emit("approval:request", { action, path }); },
    granted(action: string, path: string) { bus.emit("approval:granted", { action, path }); },
    denied(action: string, path: string) { bus.emit("approval:denied", { action, path }); },
  },
} as const;
