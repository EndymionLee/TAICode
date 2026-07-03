/** TUI Launcher */
import { Session } from "../runtime/session.js";
import { initState, pushWelcome, requestConfirm } from "./state.js";
import { renderApp } from "./app.js";
import { frameScheduler } from "./frame-scheduler.js";
import { setApprovalFn } from "../core/tools/registry.js";

export async function startTui() {
  initState();
  const session = new Session();
  await session.init();

  const welcome = [
    "",
    "  ████████╗ █████╗ ██╗",
    "  ╚══██╔══╝██╔══██╗██║",
    "     ██║   ███████║██║",
    "     ██║   ██╔══██║██║",
    "     ██║   ██║  ██║██║",
    "     ╚═╝   ╚═╝  ╚═╝╚═╝",
    "",
    "",
  ];
  pushWelcome(welcome);

  // TUI 确认弹窗
  setApprovalFn(async (action: string, path: string) => {
    return requestConfirm(`${action}: ${path}`);
  });

  frameScheduler.flushNow();
  renderApp(
    (text: string) => session.ask(text).catch(() => {}),
    async () => { await session.close(); process.exit(0); },
  );
  await new Promise(() => {});
}
