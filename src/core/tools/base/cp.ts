import * as path from "path";
import * as fsAsync from "fs/promises";
import type { ToolDefinition } from "../../types.js";
import { resolvePath } from "../utils.js";

async function copyDir(src: string, dest: string): Promise<void> {
  await fsAsync.mkdir(dest, { recursive: true });
  const entries = await fsAsync.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fsAsync.copyFile(s, d);
  }
}

export const copyFile: ToolDefinition = {
  name: "cp",
  description: "复制文件或目录到目标位置，自动创建父目录",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "源路径" },
      target: { type: "string", description: "目标路径" },
    },
    required: ["source", "target"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const src = resolvePath(String(args.source ?? ""));
    const dest = resolvePath(String(args.target ?? ""));
    try {
      const stat = await fsAsync.stat(src);
      await fsAsync.mkdir(path.dirname(dest), { recursive: true });
      if (stat.isDirectory()) { await copyDir(src, dest); return `目录复制成功: ${src} → ${dest}`; }
      await fsAsync.copyFile(src, dest);
      return `文件复制成功: ${src} → ${dest}`;
    } catch (e: any) {
      if (e?.code === "ENOENT") return `错误: 源路径不存在 — ${src}`;
      return `复制失败: ${e.message}`;
    }
  },
};
