import * as fs from "fs";
import * as fsAsync from "fs/promises";
import * as path from "path";
import type { ToolDefinition } from "../../types.js";
import { resolvePath, IGNORE_DIRS, formatSize } from "../utils.js";

async function listDirEntries(dirPath: string): Promise<{ name: string; isDir: boolean; size: number }[]> {
  const entries: { name: string; isDir: boolean; size: number }[] = [];
  let dirents: fs.Dirent[];
  try { dirents = await fsAsync.readdir(dirPath, { withFileTypes: true }); } catch { return entries; }
  for (const d of dirents) {
    if (d.isDirectory() && IGNORE_DIRS.has(d.name)) continue;
    if (d.isDirectory()) { entries.push({ name: d.name, isDir: true, size: 0 }); } else {
      try { const st = await fsAsync.stat(path.join(dirPath, d.name)); entries.push({ name: d.name, isDir: false, size: st.size }); } catch { entries.push({ name: d.name, isDir: false, size: 0 }); }
    }
  }
  entries.sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
  return entries;
}

async function _buildTree(dirPath: string, indent: string, lines: string[], maxLines: number): Promise<void> {
  const entries = await listDirEntries(dirPath);
  for (let i = 0; i < entries.length; i++) {
    if (lines.length >= maxLines) { lines.push(`${indent}... (截断)`); return; }
    const { name, isDir, size } = entries[i];
    const isLast = i === entries.length - 1;
    const prefix = isLast ? "└── " : "├── ";
    const childIndent = isLast ? "    " : "│   ";
    if (isDir) { lines.push(`${indent}${prefix}📁 ${name}/`); await _buildTree(path.join(dirPath, name), indent + childIndent, lines, maxLines); }
    else { lines.push(`${indent}${prefix}📄 ${name} (${formatSize(size)})`); }
  }
}

export const listFiles: ToolDefinition = {
  name: "ls",
  description: "列出目录内容。recursive=true 时输出树形结构。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径，默认当前工作目录" },
      recursive: { type: "boolean", description: "递归列出（树形结构）" },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const dirPath = resolvePath(String(args.path ?? "."));
    const recursive = args.recursive === true;
    try {
      if (recursive) {
        const lines: string[] = [dirPath];
        await _buildTree(dirPath, "", lines, 200);
        return lines.length > 1 ? lines.join("\n") : `目录为空: ${dirPath}`;
      }
      const entries = await listDirEntries(dirPath);
      if (entries.length === 0) return `目录为空: ${dirPath}`;
      return [`${dirPath}/`, ...entries.map(({ name, isDir, size }) => `  ${isDir ? "📁" : "📄"} ${name}${isDir ? "/" : ` (${formatSize(size)})`}`)].join("\n");
    } catch (e: any) {
      if (e?.code === "ENOENT") return `错误: 目录不存在 — ${dirPath}`;
      return `列出目录失败: ${e.message}`;
    }
  },
};
