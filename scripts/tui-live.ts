/**
 * TUI Live — node-pty 真实终端动态验收
 *
 * 起 TUI → 等就绪 → 发送聊天消息 → 等流式回复完成 → 抓屏断言:
 *   ① 用户消息有圆角气泡框 (╭─╮ / │)
 *   ② AI 回复首行 "● " 头像与文字同行 (非头像独行)
 *   ③ 输入栏 ❯ 存在
 *   ④ 无 "● ●" 双头像
 *
 * 用法: npx tsx scripts/tui-live.ts
 * 输出: scripts/tui-live.txt (ANSI 已剥离的最终抓屏)
 */
import * as pty from "node-pty";
import * as fs from "fs";
import * as path from "path";
import stripAnsi from "strip-ansi";

const REPO = path.resolve(import.meta.dirname, "..");
const WS = path.join(REPO, ".e2e");
const MSG = "你好，用一句话介绍你自己";

const term = pty.spawn(process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"], {
  name: "xterm-256color",
  cols: 90,
  rows: 28,
  cwd: REPO,
  env: {
    ...process.env,
    TAICODE_CWD: WS,
    HF_ENDPOINT: "https://hf-mirror.com",
    LOG_LEVEL: "error", // 静音日志, 抓屏干净
  } as Record<string, string>,
});

let buf = "";
term.onData((d) => { buf += d; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = () => stripAnsi(buf)
  .replace(/\r\n/g, "\n")
  // ink 逐帧重绘: 只留最后一帧之后的内容不可靠, 全量留观 + 断言用全文
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) { console.log(`[ok] ${what} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`); return true; }
    await sleep(500);
  }
  console.log(`[TIMEOUT] ${what} (${ms / 1000}s)`);
  return false;
}

async function main() {
  // ① 就绪: banner (████╗) 只在 session.init() 完成后由 renderApp 画出。
  //    之前用 ❯ 匹配会命中 npx 输出 → 1.5s 误报, 消息写进未被 ink 接管的 stdin 被丢弃
  await waitFor(() => /█+╗/.test(clean()), 120_000, "TUI banner (init 完成)");
  await sleep(3000); // ink 接管 stdin 稳定

  // ② 发消息 — 必须分包: \r 与文本同 chunk 到达时 ink 视为一次 input,
  //    key.return 检测失效 → submit 不触发 (消息滞留输入栏, 实测踩坑)
  const before = buf.length;
  term.write(MSG);
  await sleep(400);
  term.write("\r");
  await sleep(5000);
  console.log(`[diag] 发送后新增 ${buf.length - before}B`);

  // ③ 等回复完成 (Crunched 标签) — chat 流式走 llm:done
  const got = await waitFor(() => /Crunched for/.test(clean()), 150_000, "流式回复完成");

  await sleep(2000); // 末帧稳定
  const text = clean();

  // ④ 断言
  const checks: Array<[string, boolean]> = [
    ["用户气泡上框 ╭─╮", /╭─+╮/.test(text)],
    ["用户气泡内容行 │", /│\s*你好/.test(text)],
    ["AI 头像与文字同行 (● 文字)", /●\s+\S/.test(text)],
    ["无 ●● 双头像", !/●\s*●/.test(text)],
    ["输入栏 ❯", text.includes("❯")],
    ["回复完成标记 Crunched", got],
  ];
  let fail = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "✔" : "✖"} ${name}`);
    if (!ok) fail++;
  }

  const file = path.resolve(import.meta.dirname, "tui-live.txt");
  fs.writeFileSync(file, text, "utf-8");
  console.log(`抓屏已存 ${file} (${text.length}B)`);

  term.kill();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("tui-live 失败:", e); term.kill(); process.exit(2); });
