/**
 * MCP (Model Context Protocol) — 类型定义
 *
 * 基于 JSON-RPC 2.0
 */
import type { ToolDefinition } from "../types.js";

// ============================================================================
// Transport
// ============================================================================

export interface MCPServerConfig {
  name: string;
  /** 传输类型: "stdio" (本地子进程) | "sse" (远程 HTTP) */
  type: "stdio" | "sse";
  /** stdio: 启动命令 */
  command?: string;
  /** stdio: 命令行参数 */
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** sse: HTTP 地址 */
  url?: string;
  headers?: Record<string, string>;
  /** 能力覆盖 (可选, 不填则自动推断) */
  capability?: "read" | "write" | "execute";
}

// ============================================================================
// JSON-RPC
// ============================================================================

export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ============================================================================
// MCP Protocol Messages
// ============================================================================

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
}

export interface ListToolsResult {
  tools: MCPToolDef[];
}

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface CallToolResult {
  content: Array<{ type: "text" | "image" | "resource"; text?: string; data?: string }>;
  isError?: boolean;
}

// ============================================================================
// ToolDefinition 转换
// ============================================================================

/** MCP 工具 → ToolDefinition */
export function mcpToToolDef(mcp: MCPToolDef, server: string): ToolDefinition {
  return {
    name: `mcp/${server}/${mcp.name}`,
    description: mcp.description ?? `MCP tool: ${mcp.name}`,
    parameters: {
      type: "object",
      properties: Object.entries(mcp.inputSchema.properties ?? {}).reduce((acc, [k, v]) => {
        acc[k] = { type: (v as any)?.type ?? "string", description: (v as any)?.description };
        return acc;
      }, {} as Record<string, any>),
      required: mcp.inputSchema.required ?? [],
    },
    priority: 100,
    execute: undefined!, // 由 bridge 在运行时注入
  };
}

// ============================================================================
// Tool 元数据
// ============================================================================

export interface ToolMeta {
  source: "builtin" | "mcp";
  server?: string;
}

// ============================================================================
// Capability 推断
// ============================================================================

const SAFE_WORDS = ["mcp", "http", "tcp", "grpc"];
const READ_WORDS = /\b(get|read|search|list|query|find|stat|ls|show|fetch|cat|type)\b/i;
const WRITE_WORDS = /\b(write|create|delete|remove|update|rename|move|cp|mkdir|rm|sed|save|insert)\b/i;
const EXEC_WORDS = /\b(exec|run|shell|command|terminal|spawn|start|stop|build|deploy|compile|install)\b/i;

/** 根据工具名 + 描述推断 capability (配置 > 命名 > 描述 > 默认 read) */
export function inferCapability(name: string, description?: string, override?: string): "read" | "write" | "execute" {
  if (override === "read" || override === "write" || override === "execute") return override;

  // 过滤黑名单词，防止误匹配 (如 mcp 含 cp, http 含 get)
  const target = SAFE_WORDS.reduce((s, w) => s.replace(new RegExp(w, "gi"), ""), `${name} ${description ?? ""}`);

  if (EXEC_WORDS.test(target)) return "execute";
  if (WRITE_WORDS.test(target)) return "write";
  if (READ_WORDS.test(target)) return "read";

  return "read"; // 默认保守: 只读
}
