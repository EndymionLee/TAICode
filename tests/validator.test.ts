/**
 * Validator 多语言测试 — JS/TS import 提取 / 包名解析 / validateProject 集成 / autoFix JSON 安全
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extractJsImports, packageNameOfJsSpec, validateProject, autoFix } from "../src/task/validator.js";

test("extractJsImports: import from / 副作用 / require / 动态 / export from", () => {
  const code = [
    "import fs from 'fs';",
    "import { add } from './utils';",
    "import './side-effect.css';",
    "const pkg = require('@scope/pkg/sub');",
    "const lazy = () => import('../lazy/mod');",
    "export { helper } from './helpers';",
  ].join("\n");
  assert.deepEqual(extractJsImports(code), [
    "fs", "./utils", "./side-effect.css", "@scope/pkg/sub", "../lazy/mod", "./helpers",
  ]);
});

test("packageNameOfJsSpec: scoped 保留两段, bare 取首段", () => {
  assert.equal(packageNameOfJsSpec("@scope/pkg/sub"), "@scope/pkg");
  assert.equal(packageNameOfJsSpec("react-dom/client"), "react-dom");
  assert.equal(packageNameOfJsSpec("lodash"), "lodash");
});

// ============================================================================
// validateProject 集成 — 临时工作区
// ============================================================================

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-validator-"));
  process.env.TAICODE_CWD = ws;
});

test("Python: 引用未创建的本地模块 → missing_import", async () => {
  const projectDir = "proj";
  fs.mkdirSync(path.join(ws, projectDir), { recursive: true });
  fs.writeFileSync(path.join(ws, projectDir, "main.py"), "from dataset.data_loader import load\n", "utf-8");
  const tasks = [{
    id: 1, description: "写 main.py", status: "completed", result: "",
    writes: [path.join(ws, projectDir, "main.py").replace(/\\/g, "/")],
  }] as any;
  const report = await validateProject(tasks, projectDir);
  assert.ok(report.issues.some((i) => i.type === "missing_import" && i.message.includes("data_loader")));
});

test("JS: 相对引用可解析 → 无 missing_import", async () => {
  const projectDir = "app";
  fs.mkdirSync(path.join(ws, projectDir), { recursive: true });
  fs.writeFileSync(path.join(ws, projectDir, "utils.ts"), "export const add = (a: number, b: number) => a + b;\n", "utf-8");
  fs.writeFileSync(path.join(ws, projectDir, "main.ts"), "import { add } from './utils';\nconsole.log(add(1, 2));\n", "utf-8");
  const tasks = [{
    id: 1, description: "写 main.ts utils.ts", status: "completed", result: "",
    writes: [
      path.join(ws, projectDir, "main.ts").replace(/\\/g, "/"),
      path.join(ws, projectDir, "utils.ts").replace(/\\/g, "/"),
    ],
  }] as any;
  const report = await validateProject(tasks, projectDir);
  assert.ok(!report.issues.some((i) => i.type === "missing_import"));
});

test("JS: 相对引用不存在 → missing_import", async () => {
  const projectDir = "app2";
  fs.mkdirSync(path.join(ws, projectDir), { recursive: true });
  fs.writeFileSync(path.join(ws, projectDir, "main.js"), "const x = require('./missing');\n", "utf-8");
  const tasks = [{
    id: 1, description: "写 main.js", status: "completed", result: "",
    writes: [path.join(ws, projectDir, "main.js").replace(/\\/g, "/")],
  }] as any;
  const report = await validateProject(tasks, projectDir);
  assert.ok(report.issues.some((i) => i.type === "missing_import" && i.message.includes("./missing")));
});

test("package.json 缺依赖 → missing_dep + autoFix 以 JSON 方式补写 (不破坏结构)", async () => {
  const projectDir = "app3";
  fs.mkdirSync(path.join(ws, projectDir), { recursive: true });
  fs.writeFileSync(path.join(ws, projectDir, "main.js"), "import React from 'react';\n", "utf-8");
  fs.writeFileSync(path.join(ws, projectDir, "package.json"), JSON.stringify({ name: "app3", version: "1.0.0", dependencies: {} }), "utf-8");
  const writes = [
    path.join(ws, projectDir, "main.js").replace(/\\/g, "/"),
  ];
  const tasks = [{
    id: 1, description: "写 main.js", status: "completed", result: "", writes,
  }] as any;
  const report = await validateProject(tasks, projectDir);
  assert.ok(report.issues.some((i) => i.type === "missing_dep" && i.message.includes("react")));

  const fixes = await autoFix(report.issues.filter((i) => i.type === "missing_dep"));
  assert.ok(fixes.length >= 1);
  const fixed = JSON.parse(fs.readFileSync(path.join(ws, projectDir, "package.json"), "utf-8")); // 仍是合法 JSON
  assert.equal(fixed.dependencies.react, "latest");
});
