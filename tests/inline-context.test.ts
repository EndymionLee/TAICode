/**
 * Inline Context — 前置产物内联测试
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildInlineContext, inlineFileContent } from "../src/task/inline-context.js";

let ws: string;
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-inline-")); });

test("小文件全文内联", () => {
  fs.writeFileSync(path.join(ws, "a.py"), "def add(a, b):\n    return a + b\n", "utf-8");
  const out = buildInlineContext({ 1: JSON.stringify({ status: "success", created: [path.join(ws, "a.py")] }) }, { workspace: ws });
  assert.ok(out.includes("=== a.py (来自任务#1) ==="));
  assert.ok(out.includes("def add"));
  assert.ok(out.includes("无需再 read_file"));
});

test("大文件 → 首尾摘要", () => {
  const big = path.join(ws, "big.py");
  fs.writeFileSync(big, "HEAD\n" + "x\n".repeat(20000) + "TAIL\n", "utf-8");
  const out = inlineFileContent(big, 2048)!;
  assert.ok(out.includes("超过内联上限"));
  assert.ok(out.includes("HEAD"));
  assert.ok(out.includes("TAIL"));
});

test("总预算截断: 超出留提示行", () => {
  fs.writeFileSync(path.join(ws, "f1.py"), "1".repeat(3000), "utf-8");
  fs.writeFileSync(path.join(ws, "f2.py"), "2".repeat(3000), "utf-8");
  fs.writeFileSync(path.join(ws, "f3.py"), "3".repeat(3000), "utf-8");
  const out = buildInlineContext({
    1: JSON.stringify({ created: [path.join(ws, "f1.py")] }),
    2: JSON.stringify({ created: [path.join(ws, "f2.py")] }),
    3: JSON.stringify({ created: [path.join(ws, "f3.py")] }),
  }, { workspace: ws, totalBytes: 6500 });
  assert.ok(out.includes("内联总预算(6500B)已用尽"));
});

test("modified 文件也内联; 目录路径跳过", () => {
  fs.writeFileSync(path.join(ws, "m.py"), "x = 1\n", "utf-8");
  fs.mkdirSync(path.join(ws, "sub"), { recursive: true });
  const out = buildInlineContext({ 2: JSON.stringify({ modified: [path.join(ws, "m.py"), path.join(ws, "sub") + "/"] }) }, { workspace: ws });
  assert.ok(out.includes("m.py"));
  assert.ok(!out.includes("sub"));
});

test("非 JSON 结果 / 不存在文件 → 空串", () => {
  assert.equal(buildInlineContext({ 1: "not-json" }, { workspace: ws }), "");
  assert.equal(buildInlineContext({ 1: JSON.stringify({ created: [path.join(ws, "ghost.py")] }) }, { workspace: ws }), "");
});
