/**
 * WebSocket Relay — EventBus 事件 → WebSocket 客户端广播
 *
 * 核心原则不变: Runtime 只 emit, UI 只 subscribe。这里只是把 EventBus 事件桥接到 Web。
 */
import { bus } from "../core/events.js";

type WsSocket = { on(event: string, cb: (...args: any[]) => void): void; send(data: string): void; readyState: number; OPEN: number; };

const clients = new Set<WsSocket>();

export function addClient(ws: WsSocket): void {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
}

// Emittery 包装解包 — 与 TUI state.ts 一致
const d = (raw: any) => raw?.data ?? raw;

// 去掉 ANSI 颜色码
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function broadcast(type: string, data: any) {
  if (typeof data?.msg === "string") data.msg = stripAnsi(data.msg);
  if (typeof data?.text === "string") data.text = stripAnsi(data.text);
  const msg = JSON.stringify({ type, data });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

export function initRelay(): void {
  // Chat
  bus.on("chat:user", (raw: any) => broadcast("chat:user", { text: d(raw).text }));
  bus.on("chat:assistant", (raw: any) => broadcast("chat:assistant", { text: d(raw).text }));

  // LLM streaming
  bus.on("llm:start", () => broadcast("llm:start", {}));
  bus.on("llm:token", (raw: any) => broadcast("llm:token", { text: d(raw).text }));
  bus.on("llm:done", (raw: any) => broadcast("llm:done", { response: d(raw).response }));

  // Phase
  bus.on("phase:change", (raw: any) => broadcast("phase:change", { phase: d(raw).phase }));

  // Tasks
  bus.on("task:start", (raw: any) => broadcast("task:start", d(raw)));
  bus.on("task:done", (raw: any) => broadcast("task:done", d(raw)));
  bus.on("task:fail", (raw: any) => broadcast("task:fail", d(raw)));
  bus.on("task:progress", (raw: any) => broadcast("task:progress", d(raw)));

  // DAG
  bus.on("dag:start", (raw: any) => broadcast("dag:start", d(raw)));
  bus.on("dag:done", (raw: any) => broadcast("dag:done", d(raw)));

  // BigTask
  bus.on("bigtask:start", (raw: any) => broadcast("bigtask:start", d(raw)));

  // Planner
  bus.on("planner:plan", (raw: any) => broadcast("planner:plan", d(raw)));

  // Approval
  bus.on("approval:request", (raw: any) => broadcast("approval:request", d(raw)));

  // Log
  bus.on("log", (raw: any) => { const v = d(raw); broadcast("log", { level: v.level, msg: v.msg }); });
}
