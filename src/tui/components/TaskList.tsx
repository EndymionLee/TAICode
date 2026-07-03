/**
 * TaskList — 显示活跃/已完成任务
 *
 * 分离 active (带 spinner) 和 completed ([OK]/[FAIL]) 任务
 * 不再靠文本正则匹配判断任务状态
 */
import React, { memo } from "react";
import { Box, Text } from "ink";
import type { ActiveTask, CompletedTask } from "../state.js";

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

interface Props {
  activeTasks: Map<number, ActiveTask>;
  completedTasks: Map<number, CompletedTask>;
  maxLines: number;
}

export const TaskList = memo(function TaskList({ activeTasks, completedTasks, maxLines }: Props) {
  const items: React.ReactNode[] = [];

  for (const [, t] of activeTasks) {
    if (!t.description) continue;
    const ch = SPINNER[t.spinnerIdx % SPINNER.length];
    items.push(
      <Text key={`a-${t.id}`} dimColor>
        {"    "}{ch} {t.description}
      </Text>,
    );
  }

  for (const [, t] of completedTasks) {
    if (!t.description) continue;
    const marker = t.status === "completed" ? "√" : "×";
    items.push(
      <Text key={`c-${t.id}`} dimColor={t.status === "completed"}>
        {"    "}{marker} {t.description}
      </Text>,
    );
  }

  if (items.length === 0) return null;

  const visible = items.slice(-Math.max(1, maxLines));
  const pads = Math.max(0, maxLines - visible.length);

  return (
    <Box flexDirection="column" flexShrink={0} height={maxLines}>
      {Array.from({ length: pads }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
      {visible}
    </Box>
  );
});
