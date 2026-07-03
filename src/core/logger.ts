/**
 * 调试/日志模块 — 项目级统一日志系统
 *
 * 输出: console (受 LOG_LEVEL 控制) + 文件 (data/taicode.log, 始终 append)
 *
 * 用法:
 *   import { createLogger } from "../core/logger.js";
 *   const log = createLogger("module-name");
 *   log.debug("详细调试信息", { key: value });
 *
 * 控制:
 *   LOG_LEVEL=debug npm run ...
 *   LOG_LEVEL=info,task:debug npm run ...
 *   LOG_FILE=data/custom.log npm run ...
 */

import * as fs from "fs";
import * as path from "path";
import { bus } from "./events.js";
import { spanPrefix } from "./trace.js";

export enum LogLevel {
  SILENT = -1,
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.SILENT]: "SILENT",
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.WARN]: "WARN",
  [LogLevel.INFO]: "INFO",
  [LogLevel.DEBUG]: "DEBUG",
};

// ============================================================================
// ANSI 颜色
// ============================================================================

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.SILENT]: COLORS.reset,
  [LogLevel.ERROR]: COLORS.red,
  [LogLevel.WARN]: COLORS.yellow,
  [LogLevel.INFO]: COLORS.green,
  [LogLevel.DEBUG]: COLORS.dim,
};

// ============================================================================
// 配置解析
// ============================================================================

/** 解析环境变量中的日志配置 */
function parseLogConfig(): { global: LogLevel; modules: Map<string, LogLevel> } {
  const raw = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
  const modules = new Map<string, LogLevel>();
  let global: LogLevel = LogLevel.INFO;

  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes(":")) {
      const [mod, level] = part.split(":").map((s) => s.trim());
      const lvl = parseLevel(level);
      if (mod && lvl !== undefined) modules.set(mod, lvl);
    } else {
      const lvl = parseLevel(part);
      if (lvl !== undefined) global = lvl;
    }
  }

  return { global, modules };
}

function parseLevel(s: string): LogLevel | undefined {
  switch (s) {
    case "debug": return LogLevel.DEBUG;
    case "info": return LogLevel.INFO;
    case "warn": return LogLevel.WARN;
    case "error": return LogLevel.ERROR;
    case "silent": case "off": case "none": return LogLevel.SILENT;
    default: return undefined;
  }
}

// ============================================================================
// 文件日志
// ============================================================================

const LOG_FILE = process.env.LOG_FILE ?? path.resolve(process.env.TAICODE_CWD ?? process.cwd(), ".TAI", "logs", "taicode.log");
let _logStream: fs.WriteStream | null = null;

function ensureStream(): fs.WriteStream {
  if (!_logStream) {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _logStream = fs.createWriteStream(LOG_FILE, { flags: "a", encoding: "utf-8" });
    // 新文件写 BOM，Windows 工具正确识别 UTF-8
    if (!fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size === 0) {
      try { _logStream.write("﻿"); } catch { /* ignore */ }
    }
  }
  return _logStream;
}

let _fileLoggingEnabled = false;

export function toggleFileLogging(): boolean {
  _fileLoggingEnabled = !_fileLoggingEnabled;
  return _fileLoggingEnabled;
}

export function isFileLoggingEnabled(): boolean {
  return _fileLoggingEnabled;
}

function writeToFile(line: string): void {
  if (!_fileLoggingEnabled) return;
  try {
    ensureStream().write(line + "\n");
  } catch {
    // 文件写入失败不阻塞运行
  }
}

/** 刷新并关闭日志文件 (进程退出时调用) */
export function closeLogFile(): void {
  if (_logStream) {
    _logStream.end();
    _logStream = null;
  }
}

// ============================================================================
// Logger
// ============================================================================

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** 返回当前模块是否启用 debug 级别 */
  isDebug(): boolean;
}

const config = parseLogConfig();
const moduleColors = new Map<string, string>();
const colorPalette = [COLORS.cyan, COLORS.magenta, COLORS.blue, COLORS.green, COLORS.yellow];
let colorIdx = 0;

function getModuleColor(name: string): string {
  if (!moduleColors.has(name)) {
    moduleColors.set(name, colorPalette[colorIdx % colorPalette.length]);
    colorIdx++;
  }
  return moduleColors.get(name)!;
}

function getModuleLevel(name: string): LogLevel {
  if (config.modules.has(name)) return config.modules.get(name)!;
  return config.global;
}

function formatTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatData(data: unknown): string {
  if (data === undefined) return "";
  if (data instanceof Error) {
    return `\n  ${COLORS.red}${data.name}: ${data.message}${COLORS.reset}`;
  }
  try {
    const serialized = JSON.stringify(data, null, 2);
    if (serialized.length > 500) {
      return `\n  ${serialized.slice(0, 500)}... (截断)`;
    }
    return `\n  ${COLORS.dim}${serialized}${COLORS.reset}`;
  } catch {
    return ` ${String(data)}`;
  }
}

function createLogFunction(
  moduleName: string,
  level: LogLevel,
  color: string
): (msg: string, data?: unknown) => void {
  return (msg: string, data?: unknown) => {
    const moduleLevel = getModuleLevel(moduleName);
    if (moduleLevel < level) return;

    const levelColor = LEVEL_COLORS[level];
    const prefix = [
      `${COLORS.dim}${formatTime()}${COLORS.reset}`,
      `${levelColor}${LEVEL_NAMES[level].padEnd(5)}${COLORS.reset}`,
      `${color}[${moduleName}]${COLORS.reset}`,
    ].join(" ");

    const plainPrefix = `${formatTime()} ${LEVEL_NAMES[level].padEnd(5)} [${moduleName}]`;
    const output = [prefix, msg, data !== undefined ? formatData(data) : ""]
      .filter(Boolean)
      .join(" ");

    // 文件日志 (无颜色 + spanId)
    const span = spanPrefix();
    writeToFile([span, plainPrefix, msg, data !== undefined ? JSON.stringify(data) : ""].filter(Boolean).join(" "));

    // emit 到 EventBus (TUI RuntimeStore 或 CLI Renderer 各自决定如何展示)
    void bus.emit("log", { level: LEVEL_NAMES[level], msg: output, time: Date.now() });
  };
}

/** 创建模块级 Logger */
export function createLogger(moduleName: string): Logger {
  const color = getModuleColor(moduleName);
  return {
    debug: createLogFunction(moduleName, LogLevel.DEBUG, color),
    info: createLogFunction(moduleName, LogLevel.INFO, color),
    warn: createLogFunction(moduleName, LogLevel.WARN, color),
    error: createLogFunction(moduleName, LogLevel.ERROR, color),
    isDebug: () => getModuleLevel(moduleName) >= LogLevel.DEBUG,
  };
}

/** 打印当前日志配置 */
export function printLogConfig(): void {
  console.log(`${COLORS.dim}📋 日志配置: 全局=${LEVEL_NAMES[config.global]}${COLORS.reset}`);
  if (config.modules.size > 0) {
    const entries = Array.from(config.modules.entries())
      .map(([mod, lvl]) => `  ${mod}=${LEVEL_NAMES[lvl]}`)
      .join("\n");
    console.log(`${COLORS.dim}${entries}${COLORS.reset}`);
  }
}
