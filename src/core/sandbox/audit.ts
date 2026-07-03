/**
 * AuditLog — 结构化操作审计
 *
 * 记录所有 Sandbox 操作: 工具调用、文件变更、命令执行、审批结果。
 * 写入 data/audit.jsonl (追加模式, 每行一条 JSON)。
 */
import * as fs from "fs";
import * as path from "path";
import { isFileLoggingEnabled } from "../logger.js";

export interface AuditRecord {
  timestamp: number;
  tool: string;
  action: string;
  command?: string;
  path?: string;
  approved: boolean;
  success: boolean;
  durationMs?: number;
  reason?: string;
  traceId?: string;
  spanId?: string;
}

const AUDIT_FILE = path.resolve(process.env.TAICODE_CWD ?? process.cwd(), ".TAI", "logs", "audit.jsonl");

export class AuditLog {
  private enabled = true;

  log(record: AuditRecord): void {
    if (!this.enabled || !isFileLoggingEnabled()) return;
    try {
      const dir = path.dirname(AUDIT_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      // 审计写入失败不阻塞执行
    }
  }

  /** 查询最近 N 条记录 */
  tail(n: number = 50): AuditRecord[] {
    try {
      if (!fs.existsSync(AUDIT_FILE)) return [];
      const content = fs.readFileSync(AUDIT_FILE, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      return lines.slice(-n).map((l) => JSON.parse(l) as AuditRecord);
    } catch {
      return [];
    }
  }
}
