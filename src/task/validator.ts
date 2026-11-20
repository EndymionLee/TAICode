/**
 * Validator Agent — DAG 完成后验证项目完整性
 *
 * 检查 (多语言: Python + JS/TS):
 *   1. 代码 import/require 引用的本地模块是否已生成
 *   2. requirements.txt / package.json 是否包含代码中使用的第三方依赖
 *   3. spec 约束与 unexpected_file 漂移
 */
import * as fs from "fs";
import * as path from "path";
import type { SubTask } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { events } from "../core/events.js";

const log = createLogger("validator");
/** 工作区惰性读取 — import 时不固化, 测试/运行期变更 TAICODE_CWD 均生效 */
function workspace(): string {
  return process.env.TAICODE_CWD ?? process.cwd();
}

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
  const fullPath = path.resolve(workspace(), projectDir);

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

  // requirements.txt 已声明清单 (区分"缺失本地模块"与"第三方"的关键信号)
  const reqDeclared = new Set<string>();
  const reqPath0 = path.resolve(workspace(), projectDir, "requirements.txt");
  if (fs.existsSync(reqPath0)) {
    try {
      for (const line of fs.readFileSync(reqPath0, "utf-8").split("\n")) {
        const name = line.trim().split(/[=<>~#\[]/)[0].trim().toLowerCase();
        if (name) reqDeclared.add(name);
      }
    } catch { /* ignore */ }
  }

  /**
   * Python import 五分类。
   * 旧实现的 missing_import 是死代码: isLocalModule 只在"已创建"时返回 true,
   * 而外层又对已创建的 continue → 分支永不可达。
   * 新规则: 点分模块路径 (a.b) 非 stdlib/已创建/磁盘存在/requirements 声明 → 判缺失;
   * 单段顶层名未知 → 保守视为第三方跳过 (避免 numpy 误报)。
   */
  function classifyPyImport(imp: string): "stdlib" | "created" | "local" | "missing" | "third-party" {
    const top = imp.split(".")[0];
    if (PY_STDLIB.has(top)) return "stdlib";
    const expectedFile = imp.replace(/\./g, "/") + ".py";
    const base = path.basename(expectedFile).toLowerCase();
    const expectedLower = expectedFile.toLowerCase();
    if (createdFiles.has(expectedLower) || createdBasenames.has(base)) return "created";
    // 磁盘存在 (项目预置文件) → 本地可用
    if (
      fs.existsSync(path.resolve(workspace(), projectDir, expectedFile)) ||
      fs.existsSync(path.resolve(workspace(), expectedFile)) ||
      fs.existsSync(path.resolve(workspace(), projectDir, top + ".py")) ||
      fs.existsSync(path.resolve(workspace(), top + ".py"))
    ) return "local";
    if (imp.includes(".") && !reqDeclared.has(top)) return "missing";
    return "third-party";
  }

  // === 1. 检查 import/require 引用的本地模块 (Python + JS/TS) ===
  const allJsImports = new Set<string>();
  for (const t of tasks) {
    for (const w of t.writes ?? []) {
      if (!w.endsWith(".py") && !JS_FILE_RE.test(w)) continue;
      const filePath = path.resolve(workspace(), w);
      if (!fs.existsSync(filePath)) continue;

      try {
        const content = fs.readFileSync(filePath, "utf-8");

        // --- Python: 本地模块交叉引用 ---
        if (w.endsWith(".py")) {
          for (const imp of extractImports(content)) {
            if (classifyPyImport(imp) === "missing") {
              issues.push({
                type: "missing_import",
                file: w,
                message: `引用了 ${imp.replace(/\./g, "/")}.py 但未创建 (点分包路径且 requirements.txt 未声明)`,
              });
            }
          }
        }

        // --- JS/TS: 相对引用本地文件, bare 引用收集为包依赖 ---
        if (JS_FILE_RE.test(w)) {
          for (const spec of extractJsImports(content)) {
            if (isRelativeJsSpec(spec)) {
              const resolved = resolveJsLocalModule(filePath, spec);
              if (!resolved) {
                issues.push({
                  type: "missing_import",
                  file: w,
                  message: `引用了 ${spec} 但无法解析到本地模块 (未创建或路径错误)`,
                });
              }
            } else if (!spec.startsWith("node:")) {
              allJsImports.add(packageNameOfJsSpec(spec));
            }
          }
        }
      } catch { /* 跳过不可读文件 */ }
    }
  }

  // === 2. 检查 requirements.txt ===
  const reqFile = createdFiles.has("requirements.txt")
    ? path.resolve(workspace(), projectDir, "requirements.txt")
    : null;

  const allImports = new Set<string>();
  for (const t of tasks) {
    for (const w of t.writes ?? []) {
      if (!w.endsWith(".py")) continue;
      const fp = path.resolve(workspace(), w);
      if (!fs.existsSync(fp)) continue;
      try {
        const content = fs.readFileSync(fp, "utf-8");
        for (const imp of extractImports(content)) {
          const base = imp.split(".")[0];
          if (classifyPyImport(imp) === "third-party") {
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

  // === 2.5 检查 package.json 依赖 (JS/TS) ===
  const pkgFile = path.resolve(workspace(), projectDir, "package.json");
  if (allJsImports.size > 0 && fs.existsSync(pkgFile)) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgFile, "utf-8"));
      const declared = new Set([
        ...Object.keys(pkgJson.dependencies ?? {}),
        ...Object.keys(pkgJson.devDependencies ?? {}),
        ...Object.keys(pkgJson.peerDependencies ?? {}),
        ...Object.keys(pkgJson.optionalDependencies ?? {}),
      ]);
      for (const pkg of allJsImports) {
        if (!declared.has(pkg)) {
          issues.push({
            type: "missing_dep",
            file: `${projectDir}/package.json`,
            message: `代码引用了 ${pkg} 但 package.json 缺少该依赖`,
            fix: pkg,
          });
        }
      }
    } catch { /* package.json 解析失败跳过 */ }
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

// ============================================================================
// JS/TS — import / require 提取与本地模块解析
// ============================================================================

const JS_FILE_RE = /\.(mjs|cjs|js|jsx|ts|tsx)$/;

/** 提取 JS/TS 模块引用: import from / 副作用 import / require / 动态 import / export from (单遍正则, 按文档顺序) */
export function extractJsImports(code: string): string[] {
  const specs: string[] = [];
  const re = /(?:^|\n)[ \t]*(?:import|export)\s+(?:[\w$*\s{},]+from\s*)?['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) specs.push(m[1] ?? m[2] ?? m[3]!);
  return [...new Set(specs)];
}

function isRelativeJsSpec(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/") ||
         spec.startsWith(".\\") || spec.startsWith("..\\");
}

/** bare specifier → 包名 (@scope/name 保留两段) */
export function packageNameOfJsSpec(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.slice(0, 2).join("/");
  }
  return spec.split("/")[0];
}

const JS_MODULE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];

/** 相对引用 → 候选文件路径 (含 index 解析), 返回磁盘上存在的那个 */
function resolveJsLocalModule(fromFile: string, spec: string): string | null {
  const base = spec.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\.\.\//, "../");
  const dir = path.dirname(fromFile);
  const target = path.resolve(dir, base);
  // 可能带扩展名的引用
  for (const ext of JS_MODULE_EXTS) {
    const p = target + ext;
    if (fs.existsSync(p)) return p;
  }
  // 目录 index 解析
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    for (const ext of JS_MODULE_EXTS) {
      const p = path.join(target, "index" + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** 自动修复验证问题 */
export async function autoFix(issues: ValidationIssue[]): Promise<string[]> {
  const fixes: string[] = [];
  for (const issue of issues) {
    if (issue.type === "missing_dep" && issue.fix) {
      // package.json 是 JSON — 必须解析后回写, 禁止文本追加 (会破坏 JSON 结构)
      if (issue.file.endsWith("package.json")) {
        const pkgPath = path.resolve(workspace(), issue.file);
        try {
          if (fs.existsSync(pkgPath)) {
            const pkgJson = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
            const deps = pkgJson.dependencies ?? (pkgJson.dependencies = {});
            if (!deps[issue.fix]) {
              deps[issue.fix] = "latest";
              fs.writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf-8");
              fixes.push(`已添加依赖: ${issue.fix} → ${issue.file}`);
            }
          }
        } catch { /* package.json 损坏则跳过, 交给下一轮 Validator */ }
        continue;
      }
      const reqPath = path.resolve(workspace(), issue.file);
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
