/**
 * MessageArea — 纯聊天消息渲染 + 可滚动 + 视觉高度裁剪
 *
 * 核心: 按终端视觉高度 (string-width / cols) 裁剪，不是按消息数量。
 * 滚动: scrollOffset = 从底部跳过的视觉行数，内部 clamp 到有效范围。
 */
import React, { memo } from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import type { Line, LineKind } from "../state.js";

interface Props {
  lines: Line[];
  maxLines: number;
  cols: number;
  scrollOffset?: number;
}

const VISIBLE_KINDS: ReadonlySet<LineKind> = new Set(["user", "assistant", "thought", "info"]);

function visualHeight(text: string, cols: number): number {
  return Math.max(1, Math.ceil(stringWidth(stripAnsi(text)) / Math.max(1, cols)));
}

export const MessageArea = memo(function MessageArea({
  lines,
  maxLines,
  cols,
  scrollOffset = 0,
}: Props) {
  const chatLines = lines.filter((l) => VISIBLE_KINDS.has(l.kind));
  if (chatLines.length === 0) return <Box flexDirection="column" />;

  // 总视觉高度 → clamp scrollOffset
  let totalVisual = 0;
  const heights: number[] = [];
  for (let i = chatLines.length - 1; i >= 0; i--) {
    const h = visualHeight(chatLines[i].text, cols);
    heights.unshift(h);
    totalVisual += h;
  }
  const maxScroll = Math.max(0, totalVisual - maxLines);
  const clampedOffset = Math.min(scrollOffset, maxScroll);

  // 从底部向上: 跳过 clampedOffset 视觉行，再取 maxLines 视觉行
  const visible: Line[] = [];
  let toSkip = clampedOffset;
  let used = 0;

  for (let i = chatLines.length - 1; i >= 0; i--) {
    const h = heights[i];

    if (toSkip > 0) {
      toSkip -= h;
      continue;
    }

    if (used + h > maxLines) break;
    used += h;
    visible.unshift(chatLines[i]);
  }

  return (
    <Box flexDirection="column">
      {visible.map((l) => (
        <Text key={l.id} dimColor={l.kind === "thought"} bold={l.kind === "user" || l.kind === "assistant"}>
          {l.text || " "}
        </Text>
      ))}
    </Box>
  );
});
