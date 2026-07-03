/**
 * StatusBar — 显示当前会话阶段状态
 *
 * 根据 status 渲染不同文案 + braille spinner 动画
 * 替代旧的文本模式匹配 (t.startsWith("  Running") 等)
 */
import React, { useState, useEffect, memo } from "react";
import { Box, Text } from "ink";
import type { AppState, TaskStats, BigTaskInfo } from "../state.js";

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

const PHASE_LABELS: Record<AppState["status"], string> = {
  idle: "",
  thinking: "Thinking",
  planning: "Planning",
  running: "Running tasks",
  validating: "Validating",
  summarizing: "Summarizing",
};

interface Props {
  status: AppState["status"];
  taskStats: TaskStats;
  bigTask: BigTaskInfo | null;
}

function useSpinner(active: boolean, intervalMs = 120) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => setIdx((i) => (i + 1) % SPINNER.length), intervalMs);
    return () => clearInterval(iv);
  }, [active, intervalMs]);
  return SPINNER[idx];
}

export const StatusBar = memo(function StatusBar({ status, taskStats, bigTask }: Props) {
  const spinner = useSpinner(status !== "idle");
  const label = PHASE_LABELS[status];

  if (status === "idle") return null;

  const stats = status === "running" || status === "validating"
    ? ` (${taskStats.success}/${taskStats.failed}/${taskStats.skipped})`
    : "";

  return (
    <Box flexDirection="column" flexShrink={0}>
      {bigTask && (
        <Text dimColor>
          {"  "}大任务 {bigTask.current}/{bigTask.total}: {bigTask.goal}
        </Text>
      )}
      <Text dimColor>
        {"  "}{spinner} {label}{stats}
      </Text>
    </Box>
  );
});
