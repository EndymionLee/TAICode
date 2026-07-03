/**
 * PowerShell Tool — 数据结构
 */

export interface ExecuteOptions {
  /** 工作目录 */
  cwd?: string;
  /** 超时 (ms), 默认 120000 */
  timeoutMs?: number;
  /** 跳过危险命令检查 */
  allowDangerous?: boolean;
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

export type DangerLevel = "safe" | "warn" | "danger";

export interface PermissionResult {
  allowed: boolean;
  requiresApproval: boolean;
  dangerLevel: DangerLevel;
  reason?: string;
}
