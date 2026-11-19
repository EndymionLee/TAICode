/**
 * MessageArea — 对话消息渲染 (气泡布局) + 组级滚动裁剪
 *
 * 布局 (见 ../layout.ts, 测量与渲染同源):
 *   user      → 右侧圆角气泡 (cyan), 窄屏退化右缩进
 *   assistant → 左侧 ● 头像 + 折行 (首行 ● 前缀, 续行 2 空格对齐)
 *   thought   → 右对齐 dim 小字 (耗时标签, 时间戳位置)
 *   info      → 原样 (banner / 空行间距)
 * 滚动: 按组裁剪, 组不切半 (气泡/头像块保持完整)。
 */
import React, { memo } from "react";
import { Box, Text } from "ink";
import type { Line } from "../state.js";
import { groupLines, layoutGroup, scrollWindow } from "../layout.js";

interface Props {
  lines: Line[];
  maxLines: number;
  cols: number;
  scrollOffset?: number;
}

const VISIBLE_KINDS: ReadonlySet<string> = new Set(["user", "assistant", "thought", "info"]);

export const MessageArea = memo(function MessageArea({
  lines,
  maxLines,
  cols,
  scrollOffset = 0,
}: Props) {
  const chatLines = lines.filter((l) => VISIBLE_KINDS.has(l.kind));
  if (chatLines.length === 0) return <Box flexDirection="column" />;

  const layouts = groupLines(chatLines).map((g) => layoutGroup(g, cols));
  const visible = scrollWindow(layouts, maxLines, scrollOffset);
  const narrow = cols < 50;

  return (
    <Box flexDirection="column">
      {visible.map(({ group, wrapped }) => {
        switch (group.kind) {
          // ── 用户消息: 右侧圆角气泡 ──
          case "user":
            return (
              <Box key={group.id} flexDirection="column" alignItems="flex-end" paddingLeft={narrow ? 0 : 2}>
                {narrow ? (
                  // 窄屏: 块整体右靠 (外层 flex-end), 行内左对齐 (内层自然宽) — 避免右对齐锯齿
                  <Box flexDirection="column" alignItems="flex-end">
                    <Box flexDirection="column">
                      {wrapped.map((l, i) => (
                        <Text key={i} bold color="cyan">{l === "" ? " " : i === 0 ? `› ${l}` : `  ${l}`}</Text>
                      ))}
                    </Box>
                  </Box>
                ) : (
                  <Box
                    flexDirection="column"
                    borderStyle="round"
                    borderColor="cyan"
                    paddingX={1}
                  >
                    {wrapped.map((l, i) => (
                      <Text key={i} bold color="cyan">{l === "" ? " " : l}</Text>
                    ))}
                  </Box>
                )}
              </Box>
            );

          // ── AI 消息: 左侧 ● 头像 + 折行 ──
          case "assistant":
            return (
              <Box key={group.id} flexDirection="column" paddingLeft={1}>
                {wrapped.map((l, i) => (
                  <Text key={i} bold color="green">
                    {i === 0 ? "● " : "  "}{l === "" ? " " : l}
                  </Text>
                ))}
              </Box>
            );

          // ── 元信息: 右对齐 dim (时间戳位置) ──
          case "thought":
            return (
              <Box key={group.id} flexDirection="column" alignItems="flex-end">
                {wrapped.map((l, i) => (
                  <Text key={i} dimColor>{l === "" ? " " : l}</Text>
                ))}
              </Box>
            );

          // ── info: banner / 空行 原样 ──
          default:
            return (
              <Box key={group.id} flexDirection="column">
                {wrapped.map((l, i) => (
                  <Text key={i}>{l === "" ? " " : l}</Text>
                ))}
              </Box>
            );
        }
      })}
    </Box>
  );
});
