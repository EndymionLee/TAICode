import * as fsAsync from "fs/promises";
import type { ToolDefinition } from "../../types.js";
import { resolvePath, LARGE_FILE_THRESHOLD, formatSize } from "../utils.js";

export const readFile: ToolDefinition = {
  name: "read_file",
  description: "读取指定文件的全部内容（UTF-8）。大文件(>1MB)自动截断到前 10KB。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      offset: { type: "number", description: "从第几行开始读（可选）" },
      limit: { type: "number", description: "最多读几行（可选）" },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = resolvePath(String(args.path ?? ""));
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 0);
    try {
      const stat = await fsAsync.stat(filePath);
      if (stat.isDirectory()) return `错误: 路径是目录 — ${filePath}`;
      if (stat.size > LARGE_FILE_THRESHOLD && offset === 0 && limit === 0) {
        const fd = await fsAsync.open(filePath, "r");
        const buf = Buffer.alloc(10 * 1024);
        await fd.read(buf, 0, 10 * 1024, 0);
        await fd.close();
        return `${buf.toString("utf-8")}\n\n... (文件共 ${formatSize(stat.size)}，只显示前 10KB)`;
      }
      const raw = await fsAsync.readFile(filePath, "utf-8");
      if (offset > 0 || limit > 0) {
        const lines = raw.split("\n");
        const start = Math.max(0, offset);
        const end = limit > 0 ? start + limit : lines.length;
        return lines.slice(start, end).join("\n");
      }
      return raw;
    } catch (e: any) {
      if (e?.code === "ENOENT") return `错误: 文件不存在 — ${filePath}`;
      return `读取文件失败: ${e.message}`;
    }
  },
};
