/**
 * Quick Lint — Worker 收尾验证前移
 *
 * 代码层强制语法检查 (不依赖模型自觉):
 *   .py → python -m py_compile
 *   .js/.mjs/.cjs → node --check
 * 失败返回错误文本 (注入回 Worker 循环自修复), 全过返回 null。
 *
 * .ts/.tsx 故意跳过: 单文件 tsc 无 tsconfig 上下文会误报类型错 (误杀正常产出,
 * 违背"不约束模型"原则) 且 npx 启动 3-10s 吃掉验证前移省下的时延。
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

const TIMEOUT_MS = 15_000;

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
        resolve({ code: err ? ((err as any).code ?? 1) : 0, stderr: String(stderr ?? "") });
      });
      child.on("error", (e) => resolve({ code: 127, stderr: `命令不可用: ${e.message}` }));
    } catch (e) {
      resolve({ code: 127, stderr: String(e) });
    }
  });
}

const PY_RE = /\.pyw?$/i;
const JS_RE = /\.(m|c)?js$/i;
// .ts/.tsx 跳过 — 见文件头注释

/**
 * 对文件列表做语法级检查。
 * @returns null=全过; 否则首个错误的描述 (含文件名+stderr 摘要)
 */
export async function quickLint(files: string[]): Promise<string | null> {
  const seen = new Set<string>();
  for (const f of files) {
    const abs = path.resolve(f);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fs.existsSync(abs)) continue;

    if (PY_RE.test(abs)) {
      const r = await run("python", ["-m", "py_compile", abs]);
      if (r.code !== 0) return `${path.basename(abs)}: ${r.stderr.split("\n").slice(0, 6).join(" ").slice(0, 400)}`;
    } else if (JS_RE.test(abs)) {
      const r = await run("node", ["--check", abs]);
      if (r.code !== 0) return `${path.basename(abs)}: ${r.stderr.split("\n").slice(0, 6).join(" ").slice(0, 400)}`;
    }
    // 其他扩展名 (ts/json/md/txt...) 无可靠单文件检查, 跳过
  }
  return null;
}
