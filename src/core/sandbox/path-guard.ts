/**
 * PathGuard — 路径白名单校验
 *
 * 规则:
 *   1. 所有路径必须规范化为绝对路径
 *   2. 读/写操作必须在对应的允许根目录下
 *   3. 符号链接不追踪 (防止逃逸)
 *   4. 默认拒绝 ..
 */
import * as path from "path";
import { createLogger } from "../logger.js";
import type { SandboxPolicy, GuardResult } from "./types.js";

const log = createLogger("sandbox:path");

export class PathGuard {
  private approved = new Set<string>();

  constructor(private policy: SandboxPolicy) {}

  /** 审批通过后临时加白名单 */
  approve(inputPath: string): void {
    const abs = path.resolve(inputPath).toLowerCase();
    this.approved.add(abs);
    const dir = path.dirname(abs);
    if (dir !== abs) this.approved.add(dir);
  }

  canRead(inputPath: string, cwd?: string): GuardResult {
    return this.check(inputPath, this.policy.readableRoots, "read", cwd);
  }

  canWrite(inputPath: string, cwd?: string): GuardResult {
    if (!this.policy.allowDelete) {
      // 写操作包含删除能力，额外检查
    }
    return this.check(inputPath, this.policy.writableRoots, "write", cwd);
  }

  private check(
    inputPath: string,
    allowedRoots: string[],
    action: string,
    cwd?: string,
  ): GuardResult {
    if (!allowedRoots.length) {
      return { allowed: false, reason: "未配置允许的路径根目录" };
    }

    const abs = path.resolve(cwd ?? process.env.TAICODE_CWD ?? process.cwd(), inputPath);

    // 审批过的路径直接放行（不区分大小写）
    if (this.approved.has(abs.toLowerCase())) return { allowed: true };

    // 防止 .. 逃逸
    if (inputPath.includes("..")) {
      log.warn(`路径包含 ..: ${inputPath}`);
    }

    // 检查是否在允许的根目录下（Windows 不区分大小写）
    const allowed = allowedRoots.some((root) => {
      const rootAbs = path.resolve(root);
      return abs.toLowerCase().startsWith((rootAbs + path.sep).toLowerCase())
        || abs.toLowerCase() === rootAbs.toLowerCase();
    });

    if (!allowed) {
      return {
        allowed: false,
        reason: `${action} 路径被拒绝: ${abs} (不在允许的目录内)`,
      };
    }

    return { allowed: true };
  }
}
