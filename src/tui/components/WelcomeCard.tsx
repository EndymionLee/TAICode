/**
 * WelcomeCard — TUI 启动欢迎界面，位置随终端宽度自适应
 */
import React, { memo } from "react";
import { Box, Text } from "ink";

interface Props {
  model: string;
  cwd: string;
  version: string;
  cols: number;
  compact?: boolean; // 紧凑模式：只显示 logo + 版本号
}

const LOGO = [
  "████████╗ █████╗ ██╗",
  "╚══██╔══╝██╔══██╗██║",
  "   ██║   ███████║██║",
  "   ██║   ██╔══██║██║",
  "   ██║   ██║  ██║██║",
  "   ╚═╝   ╚═╝  ╚═╝╚═╝",
];

export const WelcomeCard = memo(function WelcomeCard({ model, cwd, version, cols, compact }: Props) {
  const logoPad = Math.floor(cols * 0.10);
  const verPad = Math.floor(cols * 0.04);
  const rightPad = Math.floor(cols * 0.25);
  const sepW = Math.max(16, Math.floor(cols * 0.20));
  const showText = !compact && cols >= 72;

  return (
    <Box
      borderStyle="round"
      borderColor="blue"
      flexDirection="column"
      paddingX={2}
      paddingTop={1}
      paddingBottom={0}
      width={cols}
    >
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} alignItems="center" paddingLeft={0}>
          {LOGO.map((line, i) => (
            <Text key={i} bold color="cyan">{line}</Text>
          ))}
          <Text> </Text>
          <Box paddingLeft={0}>
            <Text bold>{"TAICode v"}{version}</Text>
          </Box>
        </Box>

        {showText && (
          <Box flexDirection="column" flexGrow={1} paddingLeft={rightPad}>
            <Text bold>模型  {model}</Text>
            <Text bold>目录  {cwd}</Text>
            <Text> </Text>
            <Text bold color="blue">{"─".repeat(sepW)}</Text>
            <Text> </Text>
            <Text bold>Tips</Text>
            <Text bold>输入任务自动拆解并行执行</Text>
            <Text bold>/exit 退出</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
});
