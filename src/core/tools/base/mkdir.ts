import * as fsAsync from "fs/promises";
import type { ToolDefinition } from "../../types.js";
import { resolvePath } from "../utils.js";

export const mkdir: ToolDefinition = {
  name: "mkdir",
  description: "创建目录（自动创建父目录）",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径" },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const dirPath = resolvePath(String(args.path ?? ""));
    try {
      await fsAsync.mkdir(dirPath, { recursive: true });
      return `目录创建成功: ${dirPath}`;
    } catch (e: any) {
      return `创建目录失败: ${e.message}`;
    }
  },
};
