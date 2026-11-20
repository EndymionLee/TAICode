/**
 * Quick Lint — 验证前移测试 (py_compile / node --check)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { quickLint } from "../src/task/quick-lint.js";

test("合法 py + js → null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-lint-"));
  const py = path.join(dir, "ok.py");
  const js = path.join(dir, "ok.js");
  fs.writeFileSync(py, "def add(a, b):\n    return a + b\n", "utf-8");
  fs.writeFileSync(js, "const x = 1;\nconsole.log(x);\n", "utf-8");
  assert.equal(await quickLint([py, js]), null);
});

test("语法错误 py → 报错含文件名", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-lint2-"));
  const py = path.join(dir, "bad.py");
  fs.writeFileSync(py, "def broken(:\n", "utf-8");
  const err = await quickLint([py]);
  assert.ok(err!.includes("bad.py"));
});

test("语法错误 js → 报错", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-lint3-"));
  const js = path.join(dir, "bad.js");
  fs.writeFileSync(js, "const x = ;\n", "utf-8");
  const err = await quickLint([js]);
  assert.ok(err!.includes("bad.js"));
});

test("ts 跳过 (不误杀), 不存在文件跳过, 去重", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-lint4-"));
  const ts = path.join(dir, "complicated.ts");
  fs.writeFileSync(ts, "const x: number = undefined as any; export { x };\n", "utf-8"); // 类型上可疑但语法合法
  assert.equal(await quickLint([ts, ts, path.join(dir, "ghost.py")]), null);
});
