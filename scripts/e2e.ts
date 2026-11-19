/**
 * E2E Driver — 绕过 TUI 直接驱动 Session.ask()
 *
 * 用法: TAICODE_CWD=<workspace> npx tsx scripts/e2e.ts "用户输入"
 */
const input = process.argv[2];
if (!input) {
  console.error("用法: npx tsx scripts/e2e.ts \"用户输入\"");
  process.exit(1);
}

const { Session } = await import("../src/runtime/session.js");
const { toggleFileLogging } = await import("../src/core/logger.js");
toggleFileLogging(); // E2E 打开文件日志 → .TAI/logs/taicode.log 可观测
const s = new Session();
try {
  await s.init();
  const t0 = Date.now();
  const reply = await s.ask(input);
  console.log("\n══════════ E2E FINAL ══════════");
  console.log(reply);
  console.log(`\n[耗时 ${Math.round((Date.now() - t0) / 1000)}s | 模型 ${s.modelName} | CWD ${process.env.TAICODE_CWD}]`);
} catch (e) {
  console.error("E2E 失败:", (e as Error).stack ?? e);
  process.exitCode = 2;
} finally {
  await s.close().catch(() => {});
  process.exit(process.exitCode ?? 0);
}
