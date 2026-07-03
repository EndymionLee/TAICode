import * as fsAsync from "fs/promises";
import type { ToolDefinition } from "../../types.js";
import { resolvePath, formatSize } from "../utils.js";

export const statFile: ToolDefinition = {
  name: "stat",
  description: "获取文件或目录的详细信息（大小、修改时间、类型）",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件或目录路径" },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = resolvePath(String(args.path ?? ""));
    try {
      const s = await fsAsync.stat(filePath);
      const type = s.isDirectory() ? "📁 目录" : s.isFile() ? "📄 文件" : "🔗 其他";
      const mtime = s.mtime.toISOString().replace("T", " ").slice(0, 19);
      return [`路径: ${filePath}`, `类型: ${type}`, `大小: ${formatSize(s.size)}`, `修改: ${mtime}`].join("\n");
    } catch (e: any) {
      if (e?.code === "ENOENT") return `路径不存在: ${filePath}`;
      return `stat 失败: ${e.message}`;
    }
  },
};
