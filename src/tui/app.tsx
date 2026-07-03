/**
 * Renderer — 三层架构的 Render 层
 *
 * 时间线布局:
 *   MessageArea(pre) → StatusBar → TaskList → MessageArea(post) → spacer → BottomBar
 * 消息区支持鼠标滚轮 + PgUp/PgDown 滚动，输入框固定不动
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, render, useInput } from "ink";
import TextInput from "ink-text-input";
import { getState, subscribe, toggleAutoApprove, isAutoApprove, type ActiveTask, type CompletedTask, type TaskStats, type BigTaskInfo, type ConfirmRequest } from "./state.js";
import { toggleFileLogging, isFileLoggingEnabled } from "../core/logger.js";
import { StatusBar } from "./components/StatusBar.js";
import { TaskList } from "./components/TaskList.js";
import { MessageArea } from "./components/MessageArea.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * 过滤 SGR 鼠标序列，防止污染 TextInput。
 * Ink 内部会消费 \x1b (当作 Escape 键)，留给 TextInput 的是残余 [<d;d;dM。
 * 需要同时匹配完整形式和残余形式。
 */
function stripSGR(s: string): string {
  // SGR 鼠标序列 + Ctrl+A 残骸
  return s.replace(/(?:\x1b)?\[<(?:\d+);(?:\d+);(?:\d+)[Mm]/g, "");
}

/** 从 SGR data chunk 中提取鼠标滚轮事件并回调 */
function parseSGRWheel(data: Buffer, onWheel: (delta: number) => void): void {
  const re = /(?:\x1b)?\[<(\d+);(\d+);(\d+)[Mm]/g;
  const str = data.toString();
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    const btn = parseInt(m[1], 10);
    if (btn === 64) onWheel(3);  // 滚轮上 → 增加 offset
    if (btn === 65) onWheel(-3); // 滚轮下 → 减少 offset
  }
}

// ============================================================================
// Hooks
// ============================================================================

function useTerminalSize() {
  const [s, set] = useState({ r: process.stdout.rows ?? 24, c: process.stdout.columns ?? 80 });
  useEffect(() => {
    const fn = () => set({ r: process.stdout.rows ?? 24, c: process.stdout.columns ?? 80 });
    process.stdout.on("resize", fn);
    return () => { process.stdout.removeListener("resize", fn); };
  }, []);
  return s;
}

/** 消息滚动 — 鼠标滚轮 + PgUp/PgDown + 自动跟底 */
function useMessageScroll(lineCount: number) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const lineCountRef = useRef(lineCount);
  lineCountRef.current = lineCount;

  // 新消息到达时自动跟底
  useEffect(() => {
    setScrollOffset((prev) => (prev === 0 ? 0 : prev));
  }, [lineCount]);

  // 鼠标滚轮 — SGR mouse tracking
  useEffect(() => {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");

    const onData = (data: Buffer) => {
      parseSGRWheel(data, (delta) => {
        setScrollOffset((prev) => {
          const next = prev + delta * 3; // 1 逻辑行 ≈ 3 视觉行
          return Math.max(0, Math.min(next, lineCountRef.current * 3));
        });
      });
    };

    process.stdin.on("data", onData);
    return () => {
      process.stdin.removeListener("data", onData);
      process.stdout.write("\x1b[?1000l\x1b[?1006l");
    };
  }, []);

  // 键盘滚动 — PgUp/PgDown
  useInput((_input, key) => {
    if (key.pageUp) {
      setScrollOffset((prev) => Math.min(prev + 10, lineCountRef.current * 3));
    } else if (key.pageDown) {
      setScrollOffset((prev) => Math.max(prev - 10, 0));
    }
  });

  const resetScroll = useCallback(() => setScrollOffset(0), []);

  return { scrollOffset, resetScroll };
}

// ============================================================================
// Components
// ============================================================================

const BottomBar = React.memo(function BottomBar({
  cols, input, setInput, onSubmit,
}: {
  cols: number; input: string;
  setInput: (s: string) => void; onSubmit: () => void;
}) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{"─".repeat(cols)}</Text>
      <Box><Text bold>❯ </Text><TextInput value={input} onChange={setInput} onSubmit={onSubmit} /></Box>
      <Text dimColor>{"─".repeat(cols)}</Text>
      <Text> </Text>
    </Box>
  );
});

// ============================================================================
// App
// ============================================================================

function App({ onSubmit, onExit }: {
  onSubmit: (t: string) => void;
  onExit: () => void;
}) {
  const [input, setInput] = useState("");
  const [lines, setLines] = useState(getState().lines);
  const [status, setStatus] = useState(getState().status);
  const [activeTasks, setActiveTasks] = useState<Map<number, ActiveTask>>(new Map());
  const [completedTasks, setCompletedTasks] = useState<Map<number, CompletedTask>>(new Map());
  const [taskStats, setTaskStats] = useState<TaskStats>({ success: 0, failed: 0, skipped: 0 });
  const [bigTask, setBigTask] = useState<BigTaskInfo | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const { r: rows, c: cols } = useTerminalSize();

  // 滚动状态
  const { scrollOffset, resetScroll } = useMessageScroll(lines.length);

  // 单一订阅 → FrameScheduler 16ms 批量通知
  useEffect(() => {
    const unsub = subscribe(() => {
      const s = getState();
      setLines([...s.lines]);
      setStatus(s.status);
      setActiveTasks(new Map(s.activeTasks));
      setCompletedTasks(new Map(s.completedTasks));
      setTaskStats({ ...s.taskStats });
      setBigTask(s.bigTask ? { ...s.bigTask } : null);
      setConfirm(s.pendingConfirm);
    });
    return unsub;
  }, []);

  // TextInput onChange — 过滤 SGR 序列，防止鼠标事件污染输入框
  const handleInput = useCallback((val: string) => {
    setInput(stripSGR(val));
  }, []);

  const [toast, setToast] = useState("");
  const [autoApprove, setAutoApprove] = useState(isAutoApprove());
  const [fileLog, setFileLog] = useState(isFileLoggingEnabled());

  // toast 3 秒自动消失
  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(""), 3000); return () => clearTimeout(t); }
  }, [toast]);

  const submit = useCallback(() => {
    const t = stripSGR(input).trim();
    if (!t) return;
    setInput("");

    if (t === "/auto") {
      const on = toggleAutoApprove();
      setAutoApprove(on);
      setToast(on ? "已开启自动放行" : "已关闭自动放行");
      return;
    }

    if (t === "/log") {
      const on = toggleFileLogging();
      setFileLog(on);
      setToast(on ? "已开启文件日志" : "已关闭文件日志");
      return;
    }

    if (confirm) {
      const ok = ["y", "yes", "是"].includes(t.toLowerCase());
      confirm.resolve(ok);
      setConfirm(null);
      return;
    }

    if (t === "/exit") { onExit(); return; }
    resetScroll();
    onSubmit(t);
  }, [input, onSubmit, resetScroll, onExit, confirm]);

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexGrow={1} minHeight={0}>
        <MessageArea lines={lines} maxLines={Math.max(5, rows - 5 - (status !== "idle" ? 3 : 0) - (confirm ? 1 : 0) - (toast ? 1 : 0) - (autoApprove ? 1 : 0))} cols={cols} scrollOffset={scrollOffset} />
      </Box>
      {(status === "running" || status === "validating" || status === "planning") && (
        <StatusBar status={status} taskStats={taskStats} bigTask={bigTask} />
      )}
      {(status === "running" || status === "validating") && (
        <TaskList
          activeTasks={activeTasks}
          completedTasks={completedTasks}
          maxLines={5}
        />
      )}
      {confirm && (
        <Box flexShrink={0}>
          <Text bold color="yellow">{confirm.message} (y/N) </Text>
          <TextInput value={input} onChange={handleInput} onSubmit={submit} />
        </Box>
      )}
      {toast ? <Text dimColor>  {toast}</Text> : null}
      {autoApprove ? <Text dimColor>  自动放行已开启 (/auto 切换)</Text> : null}
      {fileLog ? <Text dimColor>  文件日志已开启 (/log 切换)</Text> : null}
      <BottomBar cols={cols} input={input} setInput={handleInput} onSubmit={submit} />
    </Box>
  );
}

export function renderApp(
  onSubmit: (t: string) => void,
  onExit: () => void,
) {
  render(React.createElement(App, { onSubmit, onExit }));
}
