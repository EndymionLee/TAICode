/**
 * TUI Live Task — 任务执行场景的真实终端动态验收
 *
 * 发真实任务 → 断言任务流 UI 与对话气泡的联动:
 *   ① 用户气泡 ② StatusBar 阶段词 (Planning/Running/Validating)
 *   ③ TaskList 任务行 (spinner/√/×) ④ 最终汇总气泡 (● + 产物名)
 *   ⑤ Crunched 标记 ⑥ 产物文件真实存在且可运行
 *
 * 用法: npx tsx scripts/tui-live-task.ts
 */
import * as pty from "node-pty";
import * as fs from "fs";
import * as path from "path";
import stripAnsi from "strip-ansi";

const REPO = path.resolve(import.meta.dirname, "..");
const WS = path.join(REPO, ".e2e");
const MSG = "创建 hello.py, 运行时打印 你好世界";

const term = pty.spawn(process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"], {
  name: "xterm-256color",
  cols: 90,
  rows: 30,
  cwd: REPO,
  env: { ...process.env, TAICODE_CWD: WS, HF_ENDPOINT: "https://hf-mirror.com", LOG_LEVEL: "error" } as Record<string, string>,
});

let buf = "";
term.onData((d) => { buf += d; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = () => stripAnsi(buf).replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) { console.log(`[ok] ${what} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`); return true; }
    await sleep(600);
  }
  console.log(`[TIMEOUT] ${what} (${ms / 1000}s)`);
  return false;
}

async function main() {
  fs.rmSync(path.join(WS, "hello.py"), { force: true });
  await waitFor(() => /█+╗/.test(clean()), 120_000, "TUI banner");
  await sleep(3000);

  // 分包写 (同 chunk 时 ink key.return 失效 — 见 tui-live.ts 注释)
  term.write(MSG);
  await sleep(400);
  term.write("\r");

  // 完成信号 = 产物落盘 + 汇总气泡出现 (Crunched 是 chat 流式路径专属标记, 任务路径本就没有)
  const done = await waitFor(
    () => fs.existsSync(path.join(WS, "hello.py")) && /●[^\n]*hello\.py/.test(clean()),
    300_000, "任务完成 (产物+汇总气泡)");
  await sleep(2000);
  const text = clean();

  const checks: Array<[string, boolean]> = [
    ["① 用户气泡 (╭─╮ + 内容)", /╭─+╮/.test(text) && /│\s*创建 hello\.py/.test(text)],
    ["② StatusBar 阶段词", /(Planning|Running tasks|Validating)/.test(text)],
    ["③ TaskList 任务行 (spinner 或 √)", /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S|√\s+\S/.test(text)],
    ["④ 汇总气泡含产物名 (● ... hello.py)", /●[^\n]*hello\.py/.test(text)],
    ["⑤ 完成终态 (输入栏就绪, 无悬挂 spinner)", done && /❯/.test(text)],
    ["⑥ 产物存在", fs.existsSync(path.join(WS, "hello.py"))],
  ];
  let fail = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? "✔" : "✖"} ${name}`); if (!ok) fail++; }

  // 产物运行验证
  if (fs.existsSync(path.join(WS, "hello.py"))) {
    const { execFileSync } = await import("child_process");
    try {
      const out = execFileSync("python", [path.join(WS, "hello.py")], { encoding: "utf-8", timeout: 15_000 });
      console.log(`${out.includes("你好世界") ? "✔" : "✖"} ⑦ 产物运行输出含「你好世界」(实际: ${out.trim().slice(0, 30)})`);
      if (!out.includes("你好世界")) fail++;
    } catch (e) {
      console.log(`✖ ⑦ 产物运行失败: ${(e as Error).message.slice(0, 80)}`); fail++;
    }
  }

  fs.writeFileSync(path.resolve(import.meta.dirname, "tui-live-task.txt"), text, "utf-8");
  console.log(`抓屏已存 scripts/tui-live-task.txt (${text.length}B)`);
  term.kill();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("tui-live-task 失败:", e); term.kill(); process.exit(2); });
