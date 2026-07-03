#!/usr/bin/env node
/**
 * TAICode 全局命令入口
 * 从任意目录执行: taicode 或 taicode --cli
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

// 在 TAICode 项目目录下执行 npx tsx src/main.ts，保持用户 CWD
const child = spawn("npx", ["tsx", "src/index.ts", ...args], {
  cwd: projectDir,
  stdio: "inherit",
  env: { ...process.env, TAICODE_CWD: process.cwd() },
  shell: true,
});

child.on("exit", (code) => process.exit(code ?? 0));
