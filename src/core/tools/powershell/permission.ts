/**
 * PermissionManager — 危险命令检测
 */

import type { PermissionResult, DangerLevel } from "./command-types.js";

const DANGER_PATTERNS: [RegExp, DangerLevel, string][] = [
  // Danger — 拒绝执行
  [/format\s/i, "danger", "格式化磁盘"],
  [/diskpart/i, "danger", "磁盘分区操作"],
  [/shutdown\s/i, "danger", "关机命令"],
  [/del\s.*\/[sfq]/i, "danger", "强制递归删除"],
  [/rm\s.*-rf\s/i, "danger", "递归强制删除根目录"],
  [/Remove-Item\s.*-Recurse\s/i, "danger", "递归删除"],
  [/rmdir\s.*\/s\s/i, "danger", "递归删除目录"],
  [/del\s.*System32/i, "danger", "删除系统文件"],

  // Warn — 需要确认
  [/rm\s/i, "warn", "删除文件"],
  [/del\s/i, "warn", "删除文件"],
  [/rmdir\s/i, "warn", "删除目录"],
  [/Remove-Item/i, "warn", "删除文件/目录"],
  [/move\s/i, "warn", "移动文件"],
  [/rename\s/i, "warn", "重命名文件"],
  [/ren\s/i, "warn", "重命名"],
  [/Set-ExecutionPolicy/i, "warn", "修改执行策略"],
];

/** 安全解释器前缀 — 这些命令开头直接放行，不检查危险模式 */
const SAFE_PREFIXES = [
  "python", "python3", "pip", "pip3", "npm", "npx", "node",
  "git", "echo", "type", "cat", "dir", "ls", "pwd", "cd",
];

export class PermissionManager {
  check(command: string): PermissionResult {
    // 安全解释器 → 直接放行
    const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase();
    if (firstWord && SAFE_PREFIXES.includes(firstWord)) {
      return { allowed: true, requiresApproval: false, dangerLevel: "safe" };
    }
    for (const [pattern, level, reason] of DANGER_PATTERNS) {
      if (pattern.test(command)) {
        if (level === "danger") {
          return { allowed: false, requiresApproval: false, dangerLevel: "danger", reason };
        }
        return { allowed: true, requiresApproval: true, dangerLevel: "warn", reason };
      }
    }
    return { allowed: true, requiresApproval: false, dangerLevel: "safe" };
  }
}
