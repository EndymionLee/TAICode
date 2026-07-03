/**
 * JSON 提取工具 — 从 LLM 回复中鲁棒提取 JSON
 *
 * LLM 经常在 JSON 前后加废话，如:
 *   "好的，这是结果：\n{...}\n希望对你有帮助"
 *   或者用 markdown fence ```json ... ```
 *
 * 本模块处理这些情况。
 */
import { createLogger } from "./logger.js";

const log = createLogger("json-utils");

/** 从 LLM 回复中提取 JSON 对象字符串 */
export function extractJson(text: string): string {
  if (!text) return "";

  // 1. 尝试 markdown fence
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith("{") || inner.startsWith("[")) return inner;
  }

  // 2. 括号计数法找最外层 { ... }（处理嵌套）
  const brace = extractBraceBalanced(text);
  if (brace) return brace;

  // 3. 兜底：正则找第一个 { 到最后一个 }
  const simple = text.match(/\{[\s\S]*\}/);
  if (simple) return simple[0].trim();

  return text.trim();
}

/** 括号计数：找到第一个 { 对应的完整 JSON */
function extractBraceBalanced(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null; // 括号不匹配
}

/** 安全解析 JSON，失败返回 null。自动修复尾部逗号 */
export function safeJsonParse<T>(text: string): T | null {
  const raw = extractJson(text);
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      // 修复尾部逗号: {"a":1,} → {"a":1}
      return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1")) as T;
    } catch {
      try {
        // 修复单引号
        return JSON.parse(raw.replace(/'/g, '"')) as T;
      } catch {
        // 尝试提取单字段 JSON
        const match = raw.match(/"([^"]+)"/);
        if (match) {
          log.warn(`JSON 解析失败，提取到字段: ${match[0].slice(0, 50)}`);
        }
        return null;
      }
    }
  }
}

/** 一行式：从 LLM 回复提取 JSON 并解析 */
export function extractAndParse<T>(text: string): T | null {
  return safeJsonParse<T>(text);
}
