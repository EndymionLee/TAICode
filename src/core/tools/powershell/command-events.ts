/**
 * PowerShell Tool — 事件定义 (通过 EventBus 发射)
 */
import type { CommandResult } from "./command-types.js";

export interface CommandStartEvent {
  command: string;
  cwd: string;
}

export interface CommandTokenEvent {
  text: string;
  stream: "stdout" | "stderr";
}

export interface CommandFinishEvent {
  result: CommandResult;
}

export interface CommandErrorEvent {
  command: string;
  error: string;
}
