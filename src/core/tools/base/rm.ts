import * as fsAsync from "fs/promises";
import type { ToolDefinition } from "../../types.js";
import { resolvePath, isIgnoredPath } from "../utils.js";
import { events } from "../../events.js";
import { approvalFn } from "../registry.js";

export const deleteFile: ToolDefinition = {
  name: "rm",
  description: "删除文件或空目录",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "要删除的文件或空目录路径" },
      recursive: { type: "boolean", description: "递归删除目录（谨慎!）" },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = resolvePath(String(args.path ?? ""));
    const recursive = args.recursive === true;
    try {
      await fsAsync.access(filePath);
      const stat = await fsAsync.stat(filePath);
      if (stat.isDirectory()) {
        if (!recursive) return `错误: 目标是目录，请设置 recursive=true 来递归删除`;
        if (isIgnoredPath(filePath)) return `错误: 拒绝删除受保护目录 — ${filePath}`;
      }
      if (approvalFn) {
        events.approval.request("删除", filePath);
        const approved = await approvalFn("删除", filePath);
        if (!approved) return `已取消删除: ${filePath}`;
      }
      if (stat.isDirectory()) {
        await fsAsync.rm(filePath, { recursive: true, force: true });
        return `目录已删除: ${filePath}`;
      }
      await fsAsync.unlink(filePath);
      return `文件已删除: ${filePath}`;
    } catch (e: any) {
      if (e?.code === "ENOENT") return `错误: 路径不存在 — ${filePath}`;
      return `删除失败: ${e.message}`;
    }
  },
};
