/**
 * Observation — 机械观察注入测试
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildObservation } from "../src/core/observation.js";

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-obs-"));
  fs.mkdirSync(path.join(ws, ".TAI"), { recursive: true });       // 应被过滤
  fs.writeFileSync(path.join(ws, ".hidden"), "x", "utf-8");       // 应被过滤
});

test("空目录 → 注入空现状", () => {
  const o = buildObservation(ws);
  assert.ok(o.note!.includes("为空"));
  assert.equal(o.entries, 0);
});

test("小目录 → 文件+子目录一层展开, 过滤 .TAI/隐藏", () => {
  fs.writeFileSync(path.join(ws, "calc.py"), "x = 1\n", "utf-8");
  fs.mkdirSync(path.join(ws, "models"), { recursive: true });
  fs.writeFileSync(path.join(ws, "models", "cnn.py"), "y = 2\n", "utf-8");
  const o = buildObservation(ws);
  assert.ok(o.note!.includes("calc.py"));
  assert.ok(o.note!.includes("models/"));
  assert.ok(o.note!.includes("cnn.py"));
  assert.ok(!o.note!.includes(".TAI"));
  assert.ok(!o.note!.includes(".hidden"));
  assert.ok(o.note!.includes("无需再用 ls/read_file"));
  assert.equal(o.entries, 2);
  assert.match(o.fingerprint, /^[0-9a-f]{12}$/);
});

test("指纹随 mtime 变化", () => {
  fs.writeFileSync(path.join(ws, "f.py"), "a", "utf-8");
  const o1 = buildObservation(ws);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(ws, "f.py"), future, future);
  const o2 = buildObservation(ws);
  assert.notEqual(o1.fingerprint, o2.fingerprint);
});

test(">50 项 → note=null 走 ReAct", () => {
  for (let i = 0; i < 51; i++) fs.writeFileSync(path.join(ws, `f${i}.py`), "x", "utf-8");
  const o = buildObservation(ws);
  assert.equal(o.note, null);
  assert.equal(o.entries, 51);
});

test("不可读目录 → note=null 不抛", () => {
  const o = buildObservation(path.join(ws, "not-exist"));
  assert.equal(o.note, null);
});
