/**
 * BudgetManager — 执行预算控制
 *
 * 防止 Agent 无限循环:
 *   - 命令数上限
 *   - 执行时间上限
 *   - 输出字节上限
 *   - 文件变更数上限
 */
import type { SandboxBudget, GuardResult } from "./types.js";

export class BudgetManager {
  private commandsUsed = 0;
  private startTime = 0;
  private outputBytes = 0;
  private fileChanges = 0;

  constructor(private budget: SandboxBudget) {}

  /** 开始新任务时重置 */
  reset(): void {
    this.commandsUsed = 0;
    this.startTime = Date.now();
    this.outputBytes = 0;
    this.fileChanges = 0;
  }

  /** 检查是否可以执行下一个命令 */
  canExecute(): GuardResult {
    if (this.commandsUsed >= this.budget.maxCommands) {
      return { allowed: false, reason: `命令数超限 (${this.budget.maxCommands})` };
    }
    const elapsed = Date.now() - this.startTime;
    if (this.startTime > 0 && elapsed >= this.budget.maxRuntimeMs) {
      return { allowed: false, reason: `执行时间超限 (${this.budget.maxRuntimeMs}ms)` };
    }
    return { allowed: true };
  }

  /** 记录命令执行 */
  recordCommand(): void {
    this.commandsUsed++;
    if (this.startTime === 0) this.startTime = Date.now();
  }

  /** 记录输出字节 */
  recordOutput(bytes: number): GuardResult {
    this.outputBytes += bytes;
    if (this.outputBytes >= this.budget.maxOutputBytes) {
      return { allowed: false, reason: `输出字节超限 (${this.budget.maxOutputBytes})` };
    }
    return { allowed: true };
  }

  /** 记录文件变更 */
  recordFileChange(): GuardResult {
    this.fileChanges++;
    if (this.fileChanges >= this.budget.maxFileChanges) {
      return { allowed: false, reason: `文件变更数超限 (${this.budget.maxFileChanges})` };
    }
    return { allowed: true };
  }

  /** 当前使用情况 */
  getStats() {
    return {
      commandsUsed: this.commandsUsed,
      runtimeMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
      outputBytes: this.outputBytes,
      fileChanges: this.fileChanges,
    };
  }
}
