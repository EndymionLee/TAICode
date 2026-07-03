/**
 * PowerShellTool — 主工具类
 *
 * 与 Agent Runtime / TUI / Planner 解耦, 只负责:
 *   1. 权限检查 (PermissionManager)
 *   2. 调用 Session (ShellSession)
 *   3. 流式事件发射 (EventBus)
 *   4. 返回结构化 CommandResult
 */
import { createLogger } from "../../logger.js";
import { bus } from "../../events.js";
import { ShellSession } from "./shell-session.js";
import { PermissionManager } from "./permission.js";
import { Sandbox } from "../../sandbox/index.js";
import { approvalFn } from "../registry.js";
import type { CommandResult, ExecuteOptions } from "./command-types.js";
import type { CommandStartEvent, CommandTokenEvent, CommandFinishEvent, CommandErrorEvent } from "./command-events.js";

const log = createLogger("powershell:tool");

/** 请求用户确认 — 30s 超时默认拒绝 */
async function requestCommandApproval(command: string): Promise<boolean> {
  if (!approvalFn) return true; // 无确认通道 → 默认放行 (CLI 模式或未注入)
  try {
    return await Promise.race([
      approvalFn("执行命令", command),
      new Promise<boolean>((r) => setTimeout(() => r(false), 30_000)),
    ]);
  } catch { return true; } // 异常 → 默认放行
}

export class PowerShellTool {
  private session: ShellSession;
  private permission = new PermissionManager();
  private sandbox: Sandbox | null = null;

  constructor(cwd?: string) {
    this.session = new ShellSession(cwd);
    this.session.onToken((e) => {
      void bus.emit("command:token" as any, e);
    });
  }

  /** 注入 Sandbox (可选, 不注入则只用 PermissionManager) */
  setSandbox(s: Sandbox): void { this.sandbox = s; }

  get cwd(): string { return this.session.cwd; }

  /** 执行命令 */
  async execute(command: string, options?: ExecuteOptions): Promise<CommandResult> {
    // 权限检查 — Sandbox (优先) 或 PermissionManager
    if (this.sandbox) {
      const guard = this.sandbox.guard({ tool: "shell", command, cwd: this.session.cwd });
      if (!guard.allowed) {
        throw new Error(`Sandbox 拒绝: ${guard.reason}`);
      }
      if (guard.requiresApproval && !options?.allowDangerous) {
        const ok = await requestCommandApproval(command);
        if (!ok) throw new Error(`已取消: 用户拒绝执行 "${command.slice(0, 80)}"`);
      }
      this.sandbox.recordCommand();
    } else {
      const perm = this.permission.check(command);
      if (!perm.allowed) {
        throw new Error(`危险命令被拒绝: ${perm.reason}`);
      }
      if (perm.requiresApproval && !options?.allowDangerous) {
        const ok = await requestCommandApproval(command);
        if (!ok) throw new Error(`已取消: 用户拒绝执行 "${command.slice(0, 80)}"`);
      }
    }

    const startEvent: CommandStartEvent = { command, cwd: this.session.cwd };
    void bus.emit("command:start" as any, startEvent);

    try {
      const result = await this.session.execute(command, options);
      const finishEvent: CommandFinishEvent = { result };
      void bus.emit("command:finish" as any, finishEvent);
      return result;
    } catch (e) {
      const errMsg = (e as Error).message;
      log.error(`命令执行失败: ${errMsg}`);
      const errorEvent: CommandErrorEvent = { command, error: errMsg };
      void bus.emit("command:error" as any, errorEvent);
      throw e;
    }
  }

  /** 取消当前执行 */
  cancel(): void {
    this.session.kill();
  }

  /** 销毁 */
  dispose(): void {
    this.session.dispose();
  }
}
