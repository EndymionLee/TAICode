import * as path from "path";
import * as fsAsync from "fs/promises";
import type { ToolDefinition } from "../../types.js";
import { resolvePath, formatSize } from "../utils.js";

export const replaceInFile: ToolDefinition = {
  name: "sed",
  description: "在文件中替换文本。old_str 必须精确匹配文件中（含缩进），替换为 new_str。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "要编辑的文件路径" },
      old_str: { type: "string", description: "要替换的原始文本（必须精确匹配）" },
      new_str: { type: "string", description: "替换后的文本" },
      insert_after: { type: "string", description: "在此文本行之后插入（可选）" },
      insert_before: { type: "string", description: "在此文本行之前插入（可选）" },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = resolvePath(String(args.path ?? ""));
    const oldStr = args.old_str ? String(args.old_str) : null;
    const newStr = args.new_str !== undefined ? String(args.new_str) : "";
    const insertAfter = args.insert_after ? String(args.insert_after) : null;
    const insertBefore = args.insert_before ? String(args.insert_before) : null;
    try {
      const stat = await fsAsync.stat(filePath);
      if (stat.isDirectory()) return `错误: 目标是目录 — ${filePath}`;
      const original = await fsAsync.readFile(filePath, "utf-8");
      if (oldStr !== null) {
        const count = (original.match(new RegExp(oldStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
        if (count === 0) return `错误: 在 ${filePath} 中未找到匹配的文本`;
        if (count > 1) return `错误: 找到 ${count} 处匹配，old_str 必须唯一`;
        const updated = original.replace(oldStr, newStr);
        await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
        await fsAsync.writeFile(filePath, updated, "utf-8");
        return `替换成功: ${filePath} (${formatSize(updated.length)})`;
      }
      if (insertAfter || insertBefore) {
        const lines = original.split("\n");
        const target = insertAfter || insertBefore;
        const matches = lines.filter((l) => l.includes(target!));
        if (matches.length === 0) return `错误: 未找到匹配 "${target}" 的行`;
        if (matches.length > 1) return `错误: 找到 ${matches.length} 处匹配`;
        const idx = lines.findIndex((l) => l.includes(target!));
        if (insertAfter) lines.splice(idx + 1, 0, newStr);
        else lines.splice(idx, 0, newStr);
        const updated = lines.join("\n");
        await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
        await fsAsync.writeFile(filePath, updated, "utf-8");
        return `插入成功: ${filePath} 第 ${idx + 1} 行`;
      }
      return "错误: 请指定 old_str 或 insert_after/insert_before";
    } catch (e: any) {
      if (e?.code === "ENOENT") return `错误: 文件不存在 — ${filePath}`;
      return `编辑失败: ${e.message}`;
    }
  },
};
