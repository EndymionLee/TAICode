/**
 * Context Fold — Worker 消息预算折叠
 *
 * 两级防线:
 *   ① truncateToolResult: 单条工具结果超限 → 首尾保留 + 中段省略 (写入时即截)
 *   ② foldMessages: 消息数超限 → 中段旧 ToolMessage 内容折叠为占位
 *      (保留 system/task/首条 AI 与最近 keepTail 条, Claude Code compact 的对应物)
 * 追加式结构不变 — 折叠发生在中段, 对前缀缓存只牺牲本已陈旧的部分。
 */
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";

const TOOL_RESULT_LIMIT = 2048;   // 单条工具结果上限
const HEAD = 1536;
const TAIL = 256;
const FOLD_THRESHOLD = 40;        // 消息条数阈值
const KEEP_TAIL = 10;             // 折叠时保留的尾部条数

/** 单条工具结果截断 (超限首尾保留) */
export function truncateToolResult(result: string, limit = TOOL_RESULT_LIMIT): string {
  if (result.length <= limit) return result;
  return `${result.slice(0, HEAD)}\n...[中段省略, 原文 ${result.length}B]...\n${result.slice(-TAIL)}`;
}

/**
 * 消息数超阈值 → 中段旧工具结果折叠为占位摘要。
 * 只动 ToolMessage 内容 (改写为短占位), 不删除消息 — 保持 tool_call_id 配对完整。
 */
export function foldMessages(messages: BaseMessage[], threshold = FOLD_THRESHOLD, keepTail = KEEP_TAIL): BaseMessage[] {
  if (messages.length <= threshold) return messages;
  const cutStart = 2; // 保留 system + 首条 task
  const cutEnd = messages.length - keepTail;
  if (cutEnd <= cutStart) return messages;

  let folded = 0;
  const out = messages.map((m, i) => {
    if (i < cutStart || i >= cutEnd) return m;
    if (m instanceof ToolMessage) {
      const content = typeof m.content === "string" ? m.content : "";
      if (content.length > 120) {
        folded++;
        return new ToolMessage({
          content: `[已折叠: 早期工具结果 ${content.length}B → 头80字] ${content.slice(0, 80)}`,
          tool_call_id: m.tool_call_id,
          name: m.name,
        });
      }
    }
    return m;
  });
  void folded; // 调试可改日志输出
  return out;
}
