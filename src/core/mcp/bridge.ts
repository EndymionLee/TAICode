/**
 * MCP Bridge — 协议层
 *
 * 负责: listTools / callTool。
 * 不负责: 生命周期 (Manager 负责), 传输 (Client 负责)。
 */
import type { ToolDefinition } from "../types.js";
import { StdioClient } from "./client/stdio.js";
import { SSEClient } from "./client/sse.js";
import type { InitializeResult, ListToolsResult, CallToolResult, MCPServerConfig } from "./types.js";
import { mcpToToolDef } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("mcp:bridge");

type Transport = StdioClient | SSEClient;

export class MCPBridge {
  private client: Transport;
  readonly serverName: string;

  constructor(config: MCPServerConfig) {
    this.serverName = config.name;
    if (config.type === "sse") {
      if (!config.url) throw new Error(`MCP "${config.name}": sse 模式缺少 url`);
      this.client = new SSEClient({ name: config.name, url: config.url, headers: config.headers });
    } else {
      if (!config.command) throw new Error(`MCP "${config.name}": stdio 模式缺少 command`);
      this.client = new StdioClient({
        name: config.name, command: config.command, args: config.args ?? [],
        env: config.env, cwd: config.cwd,
      });
    }
  }

  async connect(): Promise<void> {
    await this.client.start();
    const result = await this.client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "TAICode", version: "1.0.0" },
    }) as InitializeResult;
    log.info(`已连接 ${result.serverInfo?.name ?? "unknown"} (v${result.protocolVersion})`);
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.client.send("tools/list") as ListToolsResult;
    return (result.tools ?? []).map((t) => mcpToToolDef(t, this.serverName));
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    return await this.client.send("tools/call", { name, arguments: args }) as CallToolResult;
  }

  async disconnect(): Promise<void> {
    await this.client.stop();
  }
}
