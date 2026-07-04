/**
 * TAICode — TUI (默认) / Web (--web)
 */
export {};

// Windows: 强制控制台 UTF-8，防止 TUI 中文/Unicode 乱码
if (process.platform === "win32") {
  try {
    const { execSync } = await import("child_process");
    execSync("chcp 65001", { stdio: "pipe" });
  } catch { /* 非致命 */ }
}

const args = process.argv.slice(2);
const isWeb = args.includes("--web");

if (isWeb) {
  const { Session } = await import("./runtime/session.js");
  const session = new Session();
  await session.init();
  const { startWeb } = await import("./web/server.js");
  await startWeb(session);
} else {
  const { startTui } = await import("./tui/launcher.js");
  await startTui();
}
