/**
 * ShellSession — 每命令独立进程，无状态
 *
 * spawn 直接执行，不经过 shell 转义。
 * 支持: cwd / timeout / cancel / killTree / maxOutput
 */
import { spawn, execSync, type ChildProcess } from "child_process";
import type { CommandResult, ExecuteOptions } from "./command-types.js";
import type { CommandTokenEvent } from "./command-events.js";

const DEFAULT_TIMEOUT = 60_000;
const MAX_OUTPUT = 64 * 1024; // 64KB

/** 杀死进程树 (Windows: taskkill /T, Linux: -pid) */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /T /F 2>nul`, { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch { /* ignore */ }
}

export class ShellSession {
  private _cwd: string;
  private tokenCallback: ((e: CommandTokenEvent) => void) | null = null;
  private _current: ChildProcess | null = null;

  constructor(cwd?: string) {
    this._cwd = cwd ?? process.env.TAICODE_CWD ?? process.cwd();
  }

  get cwd(): string { return this._cwd; }

  execute(command: string, options?: ExecuteOptions): Promise<CommandResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT;
      const targetCwd = options?.cwd ?? this._cwd;

      // 解析命令为 executable + args，不经过 shell 转义
      const [exe, ...args] = parseCommand(command);
      if (!exe) {
        resolve({ command, cwd: this._cwd, exitCode: -1, stdout: "", stderr: "空命令",
          durationMs: 0, timedOut: false, cancelled: false, truncated: false });
        return;
      }

      const child = spawn(exe, args, {
        cwd: targetCwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: true, // 独立进程组，方便 killTree
      });
      this._current = child;

      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let cancelled = false;

      // 超时
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid!);
      }, timeoutMs);

      child.stdout?.on("data", (d: Buffer) => {
        if (stdout.length >= MAX_OUTPUT) { truncated = true; return; }
        const text = d.toString();
        stdout += text;
        this.tokenCallback?.({ text, stream: "stdout" });
      });

      child.stderr?.on("data", (d: Buffer) => {
        if (stderr.length >= MAX_OUTPUT) return;
        stderr += d.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        this._current = null;
        if (targetCwd !== this._cwd) this._cwd = targetCwd;

        const out = stdout.slice(0, MAX_OUTPUT);
        const err = stderr.slice(0, MAX_OUTPUT);
        const msg = err
          ? `[exit ${code}] ${err.slice(0, 500)}${out ? "\n" + out.slice(0, 500) : ""}`
          : out || "(无输出)";

        resolve({
          command, cwd: this._cwd,
          exitCode: timedOut ? -1 : cancelled ? -2 : (code ?? 0),
          stdout: msg,
          stderr: err,
          durationMs: Date.now() - startTime,
          timedOut, cancelled, truncated: truncated || stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT,
        });
      });

      child.on("error", (e) => {
        clearTimeout(timer);
        this._current = null;
        resolve({
          command, cwd: this._cwd, exitCode: -1,
          stdout: "", stderr: e.message,
          durationMs: Date.now() - startTime,
          timedOut: false, cancelled: false, truncated: false,
        });
      });
    });
  }

  onToken(cb: (e: CommandTokenEvent) => void): void { this.tokenCallback = cb; }

  kill(): void {
    if (this._current) { killTree(this._current.pid!); this._current = null; }
  }

  dispose(): void { this.kill(); }
}

/** 解析命令字符串 → [exe, ...args]，不经过 shell */
function parseCommand(command: string): string[] {
  const parts = command.trim().match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!parts) return [];
  return parts.map((p) => p.replace(/^"|"$/g, ""));
}
