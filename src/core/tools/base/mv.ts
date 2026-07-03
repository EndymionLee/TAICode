import * as path from "path";
import * as fsAsync from "fs/promises";
import type { ToolDefinition } from "../../types.js";
import { resolvePath } from "../utils.js";

export const moveFile: ToolDefinition = {
  name: "mv",
  description: "移动或重命名文件，自动创建目标目录",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "源文件路径" },
      target: { type: "string", description: "目标文件路径" },
    },
    required: ["source", "target"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const oldPath = resolvePath(String(args.source ?? ""));
    const newPath = resolvePath(String(args.target ?? ""));
    try {
      await fsAsync.access(oldPath);
      await fsAsync.mkdir(path.dirname(newPath), { recursive: true });
      await fsAsync.rename(oldPath, newPath);
      return `移动成功: ${oldPath} → ${newPath}`;
    } catch (e: any) {
      if (e?.code === "ENOENT") return `错误: 源文件不存在 — ${oldPath}`;
      return `移动失败: ${e.message}`;
    }
  },
};
