/**
 * Context Fold — 工具结果截断 + 消息折叠测试
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HumanMessage, AIMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { truncateToolResult, foldMessages } from "../src/task/context-fold.js";

test("truncateToolResult: 短文原样", () => {
  assert.equal(truncateToolResult("ok"), "ok");
  assert.equal(truncateToolResult("x".repeat(2048)), "x".repeat(2048));
});

test("truncateToolResult: 超限首尾保留+中段省略标注", () => {
  const long = "HEAD".padEnd(1600, "a") + "MID".padEnd(1600, "b") + "TAIL";
  const out = truncateToolResult(long);
  assert.ok(out.startsWith("HEAD"));
  assert.ok(out.endsWith("TAIL"));
  assert.ok(out.includes("[中段省略"));
  assert.ok(out.length < long.length);
});

test("foldMessages: ≤40 条不动", () => {
  const msgs = [new SystemMessage("s"), new HumanMessage("t"), new AIMessage("a")];
  assert.equal(foldMessages(msgs), msgs);
});

test("foldMessages: >40 条折叠中段 ToolMessage, 保头尾与配对", () => {
  const msgs: any[] = [new SystemMessage("s"), new HumanMessage("task")];
  for (let i = 0; i < 35; i++) {
    msgs.push(new AIMessage({ content: "", tool_calls: [{ id: `c${i}`, name: "x", args: {} }] }));
    msgs.push(new ToolMessage({ content: "R".repeat(500) + `#${i}`, tool_call_id: `c${i}`, name: "x" }));
  }
  msgs.push(new AIMessage("final"));
  const out = foldMessages(msgs);
  assert.equal(out.length, msgs.length); // 不删消息, 保持 tool_call 配对
  assert.equal(out[0].content, "s");           // 头保留
  assert.equal(out[out.length - 1].content, "final"); // 尾保留
  const foldedOnes = out.filter((m) => m instanceof ToolMessage && String(m.content).startsWith("[已折叠"));
  assert.ok(foldedOnes.length > 0);
  // 尾部最近 10 条未折叠
  const lastTool = [...out].reverse().find((m) => m instanceof ToolMessage) as ToolMessage;
  assert.ok(!String(lastTool.content).startsWith("[已折叠"));
  // 折叠消息保留 tool_call_id
  for (const f of foldedOnes) assert.ok((f as ToolMessage).tool_call_id);
});
