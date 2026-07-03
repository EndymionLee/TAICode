/**
 * Sandbox — 统一安全入口
 *
 * 执行流程:
 *   Policy → Path → Command → Budget → Execute
 *
 * 不改变工具代码，只在调用前后做校验。
 */
import { createLogger } from "../logger.js";
import { PathGuard } from "./path-guard.js";
import { BudgetManager } from "./budget.js";
import { PermissionManager } from "../tools/powershell/permission.js";
import { AuditLog } from "./audit.js";
import { defaultPolicy, defaultBudget } from "./policy.js";
import { currentSpan } from "../trace.js";
import type { SandboxPolicy, SandboxBudget, ToolRequest, GuardResult } from "./types.js";

const log = createLogger("sandbox");

export class Sandbox {
  readonly pathGuard: PathGuard;
  readonly budget: BudgetManager;
  readonly policy: SandboxPolicy;
  readonly audit = new AuditLog();
  private permission = new PermissionManager();

  constructor(policy?: SandboxPolicy, budget?: SandboxBudget) {
    this.policy = policy ?? defaultPolicy();
    this.pathGuard = new PathGuard(this.policy);
    this.budget = new BudgetManager(budget ?? defaultBudget());
  }

  /** 审计记录 — 自动附加当前 trace span */
  private auditLog(record: Omit<import("./audit.js").AuditRecord, "traceId" | "spanId">): void {
    const span = currentSpan();
    this.audit.log({
      ...record,
      traceId: span?.traceId,
      spanId: span?.spanId,
    });
  }

  /**
   * 在执行工具前调用 — 多层 Guard 校验
   * 返回 GuardResult — allowed=false 时拒绝执行
   */
  guard(request: ToolRequest): GuardResult {
    // 1. 预算检查
    const budgetOk = this.budget.canExecute();
    if (!budgetOk.allowed) {
      this.auditLog({ timestamp: Date.now(), tool: request.tool, action: request.action || "execute", command: request.command, path: request.path, approved: false, success: false, reason: budgetOk.reason });
      return budgetOk;
    }

    // 2. 路径检查 (跨目录 → 申请批准，不硬拒)
    if (request.path) {
      if (request.action === "write" || request.action === "delete" || request.action === "create") {
        const writeOk = this.pathGuard.canWrite(request.path, request.cwd);
        if (!writeOk.allowed) {
          return { allowed: true, requiresApproval: true, reason: `跨目录操作: ${writeOk.reason}` };
        }
      } else {
        const readOk = this.pathGuard.canRead(request.path, request.cwd);
        if (!readOk.allowed) {
          this.auditLog({ timestamp: Date.now(), tool: request.tool, action: request.action || "read", path: request.path, approved: false, success: false, reason: readOk.reason });
          return readOk;
        }
      }
    }

    // 3. 命令检查
    if (request.command) {
      const perm = this.permission.check(request.command);
      if (!perm.allowed) {
        this.auditLog({ timestamp: Date.now(), tool: request.tool, action: "execute", command: request.command, approved: false, success: false, reason: perm.reason });
        return { allowed: false, reason: `危险命令被拒绝: ${perm.reason}` };
      }
      if (perm.requiresApproval) {
        return { allowed: true, requiresApproval: true, reason: perm.reason };
      }
    }

    return { allowed: true };
  }

  /** 记录命令执行 (预算 +1) */
  recordCommand(): void {
    this.budget.recordCommand();
  }

  /** 记录文件变更 (预算 +1) */
  recordFileChange(): GuardResult {
    return this.budget.recordFileChange();
  }

  /** 记录输出字节 */
  recordOutput(bytes: number): GuardResult {
    return this.budget.recordOutput(bytes);
  }

  /** 重置预算 (新任务开始时调用) */
  reset(): void {
    this.budget.reset();
  }

  getStats() {
    return this.budget.getStats();
  }
}
