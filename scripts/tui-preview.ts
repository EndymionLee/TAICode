/**
 * TUI Preview — 把样例会话用 ink 渲染到文件 (无 TTY 验收)
 *
 * 用法: npx tsx scripts/tui-preview.ts [cols] [rows]
 * 输出: scripts/tui-preview.txt (ANSI 已剥离, 保留边框字符)
 */
import * as fs from "fs";
import * as path from "path";
import { PassThrough } from "stream";
import * as React from "react";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { MessageArea } from "../src/tui/components/MessageArea.js";
import type { Line } from "../src/tui/state.js";

const cols = Number(process.argv[2] ?? 80);
const rows = Number(process.argv[3] ?? 24);

let id = 0;
const L = (text: string, kind: Line["kind"]): Line => ({ id: ++id, text, kind });

const lines: Line[] = [
  L("", "info"),
  L("  ████████╗ █████╗ ██╗", "info"),
  L("  ╚══██╔══╝██╔══██╗██║", "info"),
  L("     ██║   ███████║██║", "info"),
  L("", "info"),
  L("你好, 帮我创建一个计算器项目", "user"),
  L("", "info"),
  L("  Thought for 2s", "thought"),
  L("", "info"),
  L("好的, 开始规划任务:", "assistant"),
  L("  1. 创建 calculator.py", "assistant"),
  L("  2. 编写测试", "assistant"),
  L("", "info"),
  L("这是一条很长的用户消息, 用来验证气泡折行效果 — 前缀缓存命中率达到 80.3%, 端到端时延从 31 秒降到 14 秒, 输入成本下降约 71%, 数据来自三轮真实 E2E 实测", "user"),
  L("", "info"),
  L("  ✻ Crunched for 14s", "thought"),
  L("", "info"),
  L("完成: 📁 文件 3 个, 全部测试通过。", "assistant"),
];

const out = new PassThrough();
let buf = "";
out.on("data", (c) => { buf += c.toString(); });

const { unmount } = render(
  React.createElement(MessageArea, { lines, maxLines: rows, cols, scrollOffset: 0 }),
  { stdout: out as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
);

setTimeout(() => {
  unmount();
  const file = path.resolve(import.meta.dirname, "tui-preview.txt");
  fs.writeFileSync(file, stripAnsi(buf), "utf-8");
  console.log(`预览已写入 ${file} (${cols}x${rows}, ${buf.length}B 原始)`);
  process.exit(0);
}, 400);
