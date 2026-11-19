/**
 * Inline Context — 前置任务产物内联
 *
 * 流水线架构的"上下文连续性补偿": 下游 Worker 直接拿到上游产物内容,
 * 省去 read_file 一轮往返。≤MAX_INLINE_BYTES 全文; 超限取首尾摘要。
 * 内容拼入 task.description (首条 HumanMessage 尾部), 不破坏 system 共享前缀。
 */
import * as fs from "fs";
import * as path from "path";
import { safeJsonParse } from "../core/json-utils.js";

const MAX_INLINE_BYTES = 8 * 1024;   // 单文件全文上限
const MAX_TOTAL_BYTES = 24 * 1024;   // 整个内联块总预算 (防 messages 膨胀挤占缓存段)
const HEAD_TAIL_BYTES = 1024;        // 超限文件的头部/尾部摘要长度
const MAX_FILES = 4;                 // 最多内联文件数

export interface InlineOptions {
  workspace?: string;
  /** 单文件全文上限 */
  maxBytes?: number;
  /** 内联块总预算 */
  totalBytes?: number;
}

/** 从单条前置结果 JSON 中提取可内联的文件路径 */
function extractArtifactFiles(rawResult: string): string[] {
  const j = safeJsonParse<{ created?: string[]; modified?: string[] }>(rawResult);
  if (!j) return [];
  return [...(j.created ?? []), ...(j.modified ?? [])].filter((f) => typeof f === "string" && !f.endsWith("/"));
}

/** 读取单文件生成内联片段; 不可读返回 null */
export function inlineFileContent(absPath: string, maxBytes = MAX_INLINE_BYTES): string | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(absPath); } catch { return null; }
  if (!stat.isFile()) return null;
  let content: string;
  try { content = fs.readFileSync(absPath, "utf-8"); } catch { return null; }

  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes <= maxBytes) {
    return content;
  }
  const head = content.slice(0, HEAD_TAIL_BYTES);
  const tail = content.slice(-HEAD_TAIL_BYTES);
  const lines = content.split("\n").length;
  return `[文件 ${bytes}B/${lines}行, 超过内联上限, 仅示首尾各1KB]\n${head}\n...(${lines - head.split("\n").length - tail.split("\n").length} 行省略)...\n${tail}`;
}

/**
 * 构造前置产物内联块。
 * @param depResults 直接前置任务的结果 (id → raw JSON string)
 * @returns 注入块 (空串表示无可内联内容)
 */
export function buildInlineContext(depResults: Record<number, string>, opts: InlineOptions = {}): string {
  const ws = (opts.workspace ?? process.env.TAICODE_CWD ?? process.cwd()).replace(/\\/g, "/");
  const maxPerFile = opts.maxBytes ?? MAX_INLINE_BYTES;
  const totalBudget = opts.totalBytes ?? MAX_TOTAL_BYTES;

  const seen = new Set<string>();
  const blocks: string[] = [];
  let used = 0;
  let truncated = false;

  outer:
  for (const [id, raw] of Object.entries(depResults)) {
    for (const f of extractArtifactFiles(raw)) {
      if (blocks.length >= MAX_FILES) break outer;
      const norm = f.replace(/\\/g, "/");
      const abs = path.isAbsolute(norm) ? norm : path.resolve(ws, norm);
      const key = abs.toLowerCase();
      if (seen.has(key)) continue;
      // 总预算: 剩余不足 512B 即止 (留提示行)
      const budget = Math.min(maxPerFile, totalBudget - used);
      if (budget <= 512) { truncated = true; break outer; }
      const content = inlineFileContent(abs, budget);
      if (content === null) continue;
      seen.add(key);
      used += Buffer.byteLength(content, "utf-8");
      const rel = norm.toLowerCase().startsWith(ws.toLowerCase()) ? norm.slice(ws.length).replace(/^\//, "") : norm;
      blocks.push(`=== ${rel} (来自任务#${id}) ===\n${content}`);
      if (used >= totalBudget) { truncated = true; break outer; }
    }
  }

  if (blocks.length === 0) return "";
  const note = truncated ? `\n[内联总预算(${totalBudget}B)已用尽, 其余前置产物请按需 read_file 自取]` : "";
  return `\n\n[前置产物已内联 — 优先直接使用, 一般无需再 read_file]\n${blocks.join("\n\n")}${note}`;
}
