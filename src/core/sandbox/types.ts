/**
 * Sandbox — 类型定义
 */

export interface SandboxPolicy {
  /** 可读根目录列表 */
  readableRoots: string[];
  /** 可写根目录列表 */
  writableRoots: string[];
  /** 允许的命令 (空=全部允许, 受 CommandGuard 约束) */
  allowedCommands?: string[];
  /** 禁止的命令 */
  deniedCommands: string[];
  /** 是否允许网络访问 */
  allowNetwork: boolean;
  /** 是否允许删除 */
  allowDelete: boolean;
  /** 是否允许跨工作区操作 */
  allowOutsideWorkspace: boolean;
}

export interface SandboxBudget {
  /** 最大命令数 (单次任务) */
  maxCommands: number;
  /** 最大执行时间 (ms) */
  maxRuntimeMs: number;
  /** 最大输出字节数 */
  maxOutputBytes: number;
  /** 最大文件变更数 */
  maxFileChanges: number;
}

export interface ToolRequest {
  tool: string;
  command?: string;
  action?: string;
  path?: string;
  paths?: string[];
  cwd?: string;
}

export interface GuardResult {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
}
