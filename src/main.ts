/**
 * TAICode — Ink TUI
 */
export {};

// Windows: 强制控制台 UTF-8，防止 TUI 中文/Unicode 乱码
if (process.platform === "win32") {
  try {
    const { execSync } = await import("child_process");
    execSync("chcp 65001", { stdio: "pipe" });
  } catch { /* 非致命 */ }
}

const { startTui } = await import("./tui/launcher.js");
await startTui();
