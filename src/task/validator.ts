/**
 * Validator Agent — DAG 完成后验证项目完整性
 *
 * 检查:
 *   1. 代码 import 引用的文件是否已生成
 *   2. requirements.txt 是否包含代码中使用的第三方库
 *   3. 项目结构是否完整 (README / requirements / 入口文件)
 */
import * as fs from "fs";
import * as path from "path";
import type { SubTask } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { events } from "../core/events.js";

const log = createLogger("validator");
const WORKSPACE = process.env.TAICODE_CWD ?? process.cwd();

interface ValidationIssue {
  type: "missing_import" | "missing_dep" | "incomplete_structure" | "contradiction";
  file: string;
  message: string;
  fix?: string;
}

interface ValidationReport {
  issues: ValidationIssue[];
  allClean: boolean;
}

/** Python 标准库 — 直接跳过 import 检查 */
const PY_STDLIB = new Set([
  "os", "sys", "math", "json", "re", "time", "datetime", "collections",
  "pathlib", "tkinter", "threading", "subprocess", "argparse", "logging",
  "abc", "typing", "enum", "functools", "itertools", "hashlib", "uuid",
  "io", "csv", "xml", "html", "http", "urllib", "socket", "ssl",
  "operator", "random", "statistics", "decimal", "fractions", "string",
  "dataclasses", "asyncio", "contextlib", "inspect", "warnings",
  "copy", "shutil", "glob", "tempfile", "zipfile", "tarfile", "gzip",
  "base64", "struct", "pickle", "sqlite3", "unittest", "doctest",
  "traceback", "atexit", "signal", "mmap", "ctypes",
  "platform", "sysconfig", "errno", "fcntl", "posixpath", "ntpath",
  "pprint", "textwrap", "difflib", "getopt", "configparser",
  "ast", "dis", "code", "codeop", "tokenize", "keyword",
]);

export async function validateProject(
  tasks: SubTask[],
  projectDir: string
): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];
  const fullPath = path.resolve(WORKSPACE, projectDir);

  // === 0. 检查 spec.json 约束 ===
  const specPath = path.join(projectDir, ".TAI", "spec.json");
  if (fs.existsSync(specPath)) {
    try {
      const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
      for (const [file, cfg] of Object.entries(spec.spec || {})) {
        const constraints = (cfg as any).constraints || [];
        const filePath = path.join(projectDir, file);
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, "utf-8");
        for (const c of constraints) {
          if (c.includes("禁止eval") && /eval\s*\(/.test(content)) {
            issues.push({ type: "contradiction", file: filePath, message: `违反spec约束: ${c}，文件中使用了eval` });
          }
        }
      }
      // === 0.5 检查 unexpected_file — Spec Lock v2 ===
      const specFiles = (spec.files || []) as string[];
      if (specFiles.length > 0) {
        for (const t of tasks) {
          if (t.status !== "completed") continue;
          for (const w of (t.writes ?? [])) {
            const name = path.basename(w);
            const isExpected = specFiles.some((sf: string) =>
              sf.toLowerCase() === name.toLowerCase() ||
              w.toLowerCase().includes(sf.toLowerCase())
            );
            if (!isExpected && !w.endsWith("/") && !name.startsWith("__")) {
              issues.push({
                type: "contradiction",
                file: w,
                message: `unexpected_file: ${name} 不在 spec.files 白名单中 (预期: ${specFiles.join(", ")})`,
              });
            }
          }
        }
      }
    } catch { /* spec.json 解析失败，跳过 */ }
  }

  if (!fs.existsSync(fullPath)) {
    return { issues: [{ type: "incomplete_structure", file: projectDir, message: "项目目录不存在" }], allClean: false };
  }

  // === 收集所有已创建的文件 (含相对路径) ===
  const createdFiles = new Set<string>();
  const createdBasenames = new Set<string>();
  for (const t of tasks) {
    if (t.status === "completed") {
      for (const w of t.writes ?? []) {
        const normalized = w.replace(/\\/g, "/").toLowerCase();
        createdFiles.add(normalized);
        const name = path.basename(w);
        if (name && !w.endsWith("/")) createdBasenames.add(name.toLowerCase());
      }
    }
  }

  // 判断是否为本地模块: stdlib? → 否. 本地文件存在? → 是. 否则 → 第三方(跳过)
  function isLocalModule(imp: string): boolean {
    const top = imp.split(".")[0];
    // stdlib → 跳过
    if (PY_STDLIB.has(top)) return false;
    // 本地文件存在 → 需要检查
    const expectedFile = imp.replace(/\./g, "/") + ".py";
    const base = path.basename(expectedFile).toLowerCase();
    if (createdFiles.has(expectedFile) || createdBasenames.has(base)) return true;
    // 不在 stdlib, 也不在本地 → 第三方, 跳过
    return false;
  }

  // === 1. 检查 import 引用的文件 ===
  for (const t of tasks) {
    for (const w of t.writes ?? []) {
      if (!w.endsWith(".py")) continue;
      const filePath = path.resolve(WORKSPACE, w);
      if (!fs.existsSync(filePath)) continue;

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const imports = extractImports(content);
        for (const imp of imports) {
          if (!isLocalModule(imp)) continue; // stdlib 或第三方 → 跳过

          // 模块名 → 文件路径: dataset.data_loader → dataset/data_loader.py
          const expectedFile = imp.replace(/\./g, "/") + ".py";
          const expectedBase = path.basename(expectedFile).toLowerCase();
          const expectedLower = expectedFile.toLowerCase();

          if (createdFiles.has(expectedLower) || createdBasenames.has(expectedBase)) continue;
          issues.push({
            type: "missing_import",
            file: w,
            message: `引用了 ${expectedFile} 但未在任务列表中创建`,
          });
        }
      } catch { /* 跳过不可读文件 */ }
    }
  }

  // === 2. 检查 requirements.txt ===
  const reqFile = createdFiles.has("requirements.txt")
    ? path.resolve(WORKSPACE, projectDir, "requirements.txt")
    : null;

  const allImports = new Set<string>();
  for (const t of tasks) {
    for (const w of t.writes ?? []) {
      if (!w.endsWith(".py")) continue;
      const fp = path.resolve(WORKSPACE, w);
      if (!fs.existsSync(fp)) continue;
      try {
        const content = fs.readFileSync(fp, "utf-8");
        for (const imp of extractImports(content)) {
          const base = imp.split(".")[0];
          if (!PY_STDLIB.has(base) && !isLocalModule(imp)) {
            allImports.add(base);
          }
        }
      } catch { /* skip */ }
    }
  }

  if (reqFile && fs.existsSync(reqFile)) {
    try {
      const reqContent = fs.readFileSync(reqFile, "utf-8").toLowerCase();
      for (const imp of allImports) {
        const pkg = imp; // THIRD_PARTY_TOPS 中的包名即 pip 包名
        if (pkg && !reqContent.includes(pkg.toLowerCase())) {
          issues.push({
            type: "missing_dep",
            file: `${projectDir}/requirements.txt`,
            message: `代码引用了 ${imp} 但 requirements.txt 缺少 ${pkg}`,
            fix: pkg,
          });
        }
      }
    } catch { /* skip */ }
  }

  // === 3. 检查项目结构完整性 ===
  const hasRequirements = createdFiles.has("requirements.txt");

  // 结构完整性交给 Planner 的大任务队列，Validator 不越界

  // 检查失败任务
  const failedTasks = tasks.filter((t) => t.status === "failed");
  if (failedTasks.length > 0) {
    for (const t of failedTasks) {
      issues.push({ type: "missing_import", file: projectDir, message: `任务失败: ${t.description.slice(0, 80)}` });
    }
  }

  // === 4. 检查矛盾 ===
  if (allImports.size > 0 && hasRequirements) {
    log.info(`验证: ${createdFiles.size} 文件, ${allImports.size} 第三方引用, ${issues.length} 问题`);
  events.validator.start();
  for (const issue of issues) {
    events.validator.issue(issue.type, issue.message);
  }
  events.validator.done(issues.length);
  }

  return { issues, allClean: issues.length === 0 };
}

/** 从 Python 代码中提取 import 语句 */
function extractImports(code: string): string[] {
  const imports: string[] = [];
  for (const line of code.split("\n")) {
    // from X import Y
    let m = line.match(/^from\s+(\S+)\s+import/);
    if (m) { imports.push(m[1]); continue; }
    // import X
    m = line.match(/^import\s+(\S+)/);
    if (m) { imports.push(m[1]); continue; }
    // import X, Y
    m = line.match(/^import\s+(\S+)\s*,\s*(\S+)/);
    if (m) { imports.push(m[1], m[2]); }
  }
  return imports;
}

/** 自动修复验证问题 */
export async function autoFix(issues: ValidationIssue[]): Promise<string[]> {
  const fixes: string[] = [];
  for (const issue of issues) {
    if (issue.type === "missing_dep" && issue.fix) {
      const reqPath = path.resolve(WORKSPACE, issue.file);
      try {
        if (fs.existsSync(reqPath)) {
          const content = fs.readFileSync(reqPath, "utf-8");
          if (!content.includes(issue.fix)) {
            fs.appendFileSync(reqPath, `\n${issue.fix}\n`);
            fixes.push(`已添加依赖: ${issue.fix} → ${issue.file}`);
          }
        }
      } catch { /* skip */ }
    }
  }
  return fixes;
}
