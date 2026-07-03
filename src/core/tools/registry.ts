/**
 * Tool Registry — 所有工具统一注册中心
 *
 * 新增工具: 在 base/ 创建文件 → 在此 import → 加入 toolsList
 * MCP:      配置 data/mcp-servers.json → loadMCPTools() 自动发现
 */
import type { ToolDefinition } from "../types.js";
import type { ToolMeta } from "../mcp/types.js";
import { createLogger } from "../logger.js";
import { events } from "../events.js";
import { spanPrefix } from "../trace.js";
import { Sandbox } from "../sandbox/index.js";

// 基础工具
import { readFile } from "./base/read-file.js";
import { writeFile } from "./base/write-file.js";
import { mkdir } from "./base/mkdir.js";
import { copyFile } from "./base/cp.js";
import { moveFile } from "./base/mv.js";
import { deleteFile } from "./base/rm.js";
import { statFile } from "./base/stat.js";
import { listFiles } from "./base/ls.js";
import { searchFiles } from "./base/find.js";
import { searchContent } from "./base/grep.js";
import { replaceInFile } from "./base/sed.js";

// PowerShell 后备工具
import { PowerShellTool } from "./powershell/index.js";

const log = createLogger("tools");

// ============================================================================
// Sandbox 单例
// ============================================================================

let _sandbox: Sandbox | null = null;

function getSandbox(): Sandbox {
  if (!_sandbox) _sandbox = new Sandbox();
  return _sandbox;
}

export function getSandboxInstance(): Sandbox {
  return getSandbox();
}

// ============================================================================
// PowerShell 工具
// ============================================================================

let _psTool: PowerShellTool | null = null;

function getPowerShellTool(): PowerShellTool {
  if (!_psTool) {
    _psTool = new PowerShellTool();
    _psTool.setSandbox(getSandbox());
  }
  return _psTool;
}

const runShellCommand: ToolDefinition = {
  name: "shell",
  description: "【后备工具】在 PowerShell 中执行命令。仅在基础工具无法完成时使用。适用: npm install、git、python 脚本、复杂管道。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      cwd: { type: "string", description: "工作目录，默认当前目录" },
      timeoutMs: { type: "number", description: "超时毫秒，默认 60000" },
    },
    required: ["command"],
  },
  execute: async (args: Record<string, unknown>) => {
    const ps = getPowerShellTool();
    const command = String(args.command ?? "");
    const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
    const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
    const result = await ps.execute(command, { cwd, timeoutMs });
    return result.truncated
      ? `[截断] ${result.stdout}\n⏱️ ${result.durationMs}ms, cwd=${result.cwd}`
      : `${result.stdout}\n⏱️ ${result.durationMs}ms, cwd=${result.cwd}`;
  },
};

export function disposePowerShell(): void {
  if (_psTool) { _psTool.dispose(); _psTool = null; }
}

// ============================================================================
// 权限确认回调 (由 CLI Session 注入)
// ============================================================================

export let approvalFn: ((action: string, filePath: string) => Promise<boolean>) | null = null;

export function setApprovalFn(fn: (action: string, filePath: string) => Promise<boolean>): void {
  approvalFn = fn;
}

// ============================================================================
// 工具注册表
// ============================================================================

/** 所有工具 (按优先级排列: 语义工具 100, shell 1) */
export const toolsList: ToolDefinition[] = [
  readFile,
  writeFile,
  mkdir,
  copyFile,
  moveFile,
  deleteFile,
  statFile,
  listFiles,
  searchFiles,
  searchContent,
  replaceInFile,
  runShellCommand,
];

for (const t of toolsList) {
  t.priority = t.name === "shell" ? 1 : 100;
  t.capability = t.name === "shell" ? "execute"
    : t.name === "write_file" || t.name === "mv" || t.name === "rm" || t.name === "mkdir" || t.name === "cp" || t.name === "sed" ? "write"
    : "read";
}

export const TOOL_MAP: Record<string, ToolDefinition> = Object.fromEntries(
  toolsList.map((t) => [t.name, t]),
);

// ============================================================================
// 深拷贝 + Sandbox 包裹 + 日志/耗时
// ============================================================================

export function deepCloneTools(): Record<string, ToolDefinition> {
  const cloned: Record<string, ToolDefinition> = {};
  for (const [name, tool] of Object.entries(TOOL_MAP)) {
    const toolCopy: ToolDefinition = {
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(JSON.stringify(tool.parameters)),
      execute: tool.execute,
    };
    const originalExecute = toolCopy.execute;
    toolCopy.execute = async (args: Record<string, unknown>) => {
      const sandbox = getSandboxInstance();
      const filePath = args.path ? String(args.path) : (args.source ? String(args.source) : undefined);
      const action = name === "rm" ? "delete"
        : name === "write_file" || name === "mv" || name === "sed" || name === "mkdir" || name === "cp" ? "write"
        : "read";

      if (filePath) {
        const guard = sandbox.guard({ tool: name, action, path: filePath, paths: args.paths as string[] | undefined });
        if (!guard.allowed) return `Sandbox 拒绝: ${guard.reason}`;
        if (guard.requiresApproval) {
          if (approvalFn) {
            const ok = await approvalFn("跨目录操作", filePath);
            if (!ok) return `已取消: ${guard.reason}`;
            sandbox.pathGuard.approve(filePath); // 加白名单，后续不再拦
          } else {
            return `需要确认: ${guard.reason}（当前环境不支持交互确认）`;
          }
        }
      }
      if (action === "write" || action === "delete") {
        const fc = sandbox.recordFileChange();
        if (!fc.allowed) return `Sandbox 预算超限: ${fc.reason}`;
      }

      const startTime = Date.now();
      events.tool.call(name, args);
      log.debug(`${spanPrefix()} ${name}(${JSON.stringify(args).slice(0, 200)})`);
      try {
        const result = await originalExecute(args);
        const duration = Date.now() - startTime;
        sandbox.recordOutput(Buffer.byteLength(result, "utf-8"));
        events.tool.result(name, result, duration);
        log.debug(`${name} → ${result.slice(0, 150)}`);
        return result;
      } catch (e) {
        const duration = Date.now() - startTime;
        events.tool.result(name, `错误: ${(e as Error).message}`, duration);
        log.warn(`${name} 失败: ${(e as Error).message}`);
        throw e;
      }
    };
    cloned[name] = toolCopy;
  }
  return cloned;
}

// ============================================================================
// MCP 工具集成
// ============================================================================

import { MCPServerManager } from "../mcp/manager.js";

/** 工具 → 元数据 */
export const toolMeta = new Map<string, ToolMeta>();

// 内置工具标记
for (const t of toolsList) {
  toolMeta.set(t.name, { source: "builtin" });
}

let _mcpManager: MCPServerManager | null = null;

/** 加载 MCP 工具 (不阻塞启动，完成后自动注册) */
export function loadMCPTools(configPath?: string): Promise<ToolDefinition[]> {
  return new Promise((resolve) => {
    if (_mcpManager) { resolve([]); return; }
    _mcpManager = new MCPServerManager();
    _mcpManager.loadConfig(configPath);

    // 异步发现，不阻塞 session.init()
    _mcpManager.discoverAll().then((mcpTools) => {
      for (const [name, meta] of _mcpManager!.toolMeta) {
        toolMeta.set(name, meta);
      }
      toolsList.push(...mcpTools);
      for (const t of mcpTools) {
        TOOL_MAP[t.name] = t;
      }
      resolve(mcpTools);
    }).catch(() => resolve([]));
  });
}

/** 停止所有 MCP 服务器 */
export async function stopMCP(): Promise<void> {
  if (_mcpManager) { await _mcpManager.stopAll(); _mcpManager = null; }
}

