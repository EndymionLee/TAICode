/**
 * MCP Manager — 生命周期管理
 *
 * 负责: loadConfig / startServers / stopServers / discoverTools
 * 不负责: 协议 (Bridge 负责), 传输 (Client 负责)
 */
import * as fs from "fs";
import * as path from "path";
import { MCPBridge } from "./bridge.js";
import type { ToolDefinition } from "../types.js";
import type { MCPServerConfig, ToolMeta } from "./types.js";
import { inferCapability } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("mcp:manager");

const DEFAULT_CONFIG_PATH = path.resolve(process.env.TAICODE_CWD ?? process.cwd(), ".TAI", "mcp-servers.json");

export class MCPServerManager {
  private bridges = new Map<string, MCPBridge>();
  private configs: MCPServerConfig[] = [];
  /** 工具 → 元数据 */
  readonly toolMeta = new Map<string, ToolMeta>();

  /** 加载服务器配置 */
  loadConfig(configPath?: string): MCPServerConfig[] {
    const p = configPath ?? DEFAULT_CONFIG_PATH;
    try {
      if (!fs.existsSync(p)) {
        log.info(`MCP 配置文件不存在: ${p}`);
        this.configs = [];
        return [];
      }
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      this.configs = (raw.servers ?? []) as MCPServerConfig[];
      log.info(`加载 ${this.configs.length} 个 MCP 服务器配置`);
      return this.configs;
    } catch (e) {
      log.warn(`MCP 配置加载失败: ${(e as Error).message}`);
      this.configs = [];
      return [];
    }
  }

  /** 启动所有已配置的服务器并发现工具 */
  async discoverAll(): Promise<ToolDefinition[]> {
    const allTools: ToolDefinition[] = [];

    for (const config of this.configs) {
      try {
        const bridge = new MCPBridge(config);
        // 10s 超时保护，防止 Python 服务器启动慢卡整个 TUI
        await Promise.race([
          bridge.connect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("连接超时(10s)")), 10_000)),
        ]);
        this.bridges.set(config.name, bridge);

        const tools = await Promise.race([
          bridge.listTools(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("listTools 超时(10s)")), 10_000)),
        ]) as ToolDefinition[];
        log.info(`${config.name}: 发现 ${tools.length} 个工具`);

        // 注入 execute + 推断 capability
        for (const tool of tools) {
          const mcpName = tool.name; // 格式: mcp/{server}/{tool}
          tool.capability = inferCapability(tool.name, tool.description, config.capability);
          tool.execute = async (args: Record<string, unknown>) => {
            const result = await bridge.callTool(mcpName.split("/").slice(2).join("/"), args);
            return result.content.map((c) => c.text ?? "").join("\n") || "(无输出)";
          };
          this.toolMeta.set(tool.name, { source: "mcp", server: config.name });
        }

        allTools.push(...tools);
      } catch (e) {
        log.warn(`MCP 服务器 "${config.name}" 启动失败: ${(e as Error).message}`);
      }
    }

    return allTools;
  }

  /** 停止所有服务器 */
  async stopAll(): Promise<void> {
    for (const [name, bridge] of this.bridges) {
      try { await bridge.disconnect(); } catch { /* ignore */ }
      log.info(`${name}: 已断开`);
    }
    this.bridges.clear();
  }

  /** 获取工具元数据 */
  getMeta(toolName: string): ToolMeta | undefined {
    return this.toolMeta.get(toolName);
  }
}
