import * as path from "path";
import * as fsAsync from "fs/promises";
import type { ToolDefinition } from "../../types.js";
import { resolvePath, formatSize } from "../utils.js";

export const writeFile: ToolDefinition = {
  name: "write_file",
  description: "将内容写入文件，自动创建父目录",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件路径" },
      content: { type: "string", description: "要写入的内容" },
    },
    required: ["path", "content"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = resolvePath(String(args.path ?? ""));
    const content = String(args.content ?? "");
    try {
      await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
      await fsAsync.writeFile(filePath, content, "utf-8");
      return `文件写入成功: ${filePath} (${formatSize(content.length)})`;
    } catch (e: any) {
      return `写入文件失败: ${e.message}`;
    }
  },
};
