/**
 * Worker Output — Worker 结构化输出契约 (纯函数, 可单测)
 *
 * 从 worker.ts 抽出: JSON parse 失败时返回标准化 error JSON, 永不透传 raw text。
 */
import { extractJson } from "../core/types.js";

export interface WorkerOutput {
  status: string;
  summary: string;
  cwd: string;
  created: string[];
  deleted: string[];
  modified: string[];
  read: string[];
  error: string | null;
  task_id?: number;
  [key: string]: unknown;
}

/** Worker 输出标准化 — JSON parse 失败时返回 error JSON，永不透传 raw text */
export function parseWorkerOutput(result: string, taskDesc?: string, taskId?: number): string {
  const errorOutput = (reason: string): string => JSON.stringify({
    status: "failed",
    summary: `Worker 输出格式错误: ${reason}`,
    cwd: "",
    created: [], deleted: [], modified: [], read: [],
    error: "输出格式错误",
    task_id: taskId,
  });

  const extracted = extractJson(result);
  const json = extracted || result;

  let parsed: Partial<WorkerOutput>;
  try { parsed = JSON.parse(json); }
  catch {
    return errorOutput(`无法解析为 JSON: ${result.slice(0, 100)}`);
  }

  // 字段补全
  if (taskId !== undefined) parsed.task_id = taskId;
  if (!parsed.cwd) {
    const firstPath = (parsed.created ?? []).concat(parsed.deleted ?? [], parsed.modified ?? [])[0];
    if (firstPath) parsed.cwd = firstPath.replace(/[/\\][^/\\]*$/, "");
    else if (taskDesc) {
      // 兜底: 从任务描述提取完整 Windows 路径 (旧正则排除反斜杠, 多级路径只能截到首段)
      const m = taskDesc.match(/([A-Za-z]:\\(?:[^\s，,:*?"<>|]+\\)*[^\s，,:*?"<>|]*)/i);
      if (m) {
        let p = m[1].replace(/\\+$/, "");
        // 指向文件 (basename 带扩展名) → 取其目录
        if (/[\\/][^\\/]+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(p)) p = p.replace(/[\\/][^\\/]*$/, "");
        parsed.cwd = p;
      } else {
        parsed.cwd = "";
      }
    } else {
      parsed.cwd = "";
    }
  }
  // 确保必需字段存在 + 常见拼写容错 (局部变量避免属性窄化被后续赋值打断)
  parsed.status = parsed.status || "failed";
  const summary = typeof parsed.summary === "string" ? parsed.summary
    : typeof (parsed as any).sumary === "string" ? (parsed as any).sumary  // LLM 常见 typo
    : "";
  parsed.summary = summary;
  parsed.created = parsed.created || [];
  parsed.deleted = parsed.deleted || [];
  parsed.modified = parsed.modified || [];
  parsed.read = parsed.read || [];
  parsed.error = parsed.error || null;

  // 硬截断 summary
  if (summary.length > 120) {
    parsed.summary = summary.slice(0, 120) + "...";
  }

  return JSON.stringify(parsed);
}
