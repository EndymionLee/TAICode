/**
 * Policy — 默认安全策略
 */
import * as path from "path";
import type { SandboxPolicy, SandboxBudget } from "./types.js";

/** 默认工作区 = CWD */
import { createLogger } from "../logger.js";
const log = createLogger("sandbox:policy");

export function defaultWorkspace(): string {
  const dir = (process.env.TAICODE_CWD ?? process.cwd()).toLowerCase();
  log.info(`工作区: TAICODE_CWD=${process.env.TAICODE_CWD ?? "(未设)"} → ${dir}`);
  return dir;
}

/** 默认安全策略 */
export function defaultPolicy(workspace?: string): SandboxPolicy {
  const ws = path.resolve(workspace ?? defaultWorkspace());
  return {
    readableRoots: [ws],
    writableRoots: [ws],
    deniedCommands: [
      "format", "diskpart", "shutdown", "reg delete",
      "Remove-Item -Recurse C:", "rm -rf /", "del /f /s C:",
    ],
    allowNetwork: false,
    allowDelete: true,
    allowOutsideWorkspace: false,
  };
}

/** 默认预算 */
export function defaultBudget(): SandboxBudget {
  return {
    maxCommands: 100,
    maxRuntimeMs: 300_000, // 5 分钟
    maxOutputBytes: 10 * 1024 * 1024, // 10MB
    maxFileChanges: 1000,
  };
}
