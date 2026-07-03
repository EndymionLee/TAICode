import * as fs from "fs";
import * as fsAsync from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import type { ToolDefinition } from "../../types.js";
import { resolvePath, IGNORE_DIRS, MAX_GREP_RESULTS, formatSize } from "../utils.js";

function matchGlob(filename: string, pattern: string): boolean {
  return new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i").test(filename);
}

async function collectFiles(rootDir: string, glob: string | null, out: string[]): Promise<void> {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fsAsync.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!IGNORE_DIRS.has(entry.name)) stack.push(fp); }
      else if (!glob || matchGlob(entry.name, glob)) { out.push(fp); }
    }
  }
}

async function grepFile(filePath: string, regex: RegExp, context: number, maxResults: number): Promise<string[]> {
  const results: string[] = [];
  try {
    const stat = await fsAsync.stat(filePath);
    if (stat.size === 0 || stat.size > 100 * 1024 * 1024) { if (stat.size > 100 * 1024 * 1024) results.push(`${filePath}: (过大 ${formatSize(stat.size)}，跳过)`); return results; }
    const fileStream = fs.createReadStream(filePath, { encoding: "utf-8", highWaterMark: 64 * 1024 });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    const ringBuffer: string[] = [];
    const RING_SIZE = context * 2 + 1;
    let lineNum = 0, pendingAfter = 0, fileMatchCount = 0;
    for await (const line of rl) {
      lineNum++;
      ringBuffer.push(line);
      if (ringBuffer.length > RING_SIZE) ringBuffer.shift();
      if (pendingAfter > 0) { results.push(`${filePath}:${lineNum}: ${line.trim()}`); fileMatchCount++; pendingAfter--; if (fileMatchCount >= maxResults) break; continue; }
      regex.lastIndex = 0;
      if (regex.test(line)) {
        fileMatchCount++;
        const startIdx = Math.max(0, ringBuffer.length - context - 1);
        for (let i = startIdx; i < ringBuffer.length - 1; i++) results.push(`${filePath}:${lineNum - (ringBuffer.length - 1 - i)}: ${ringBuffer[i].trim()}`);
        results.push(`${filePath}:${lineNum}: ${line.trim()}`);
        pendingAfter = context;
        if (fileMatchCount >= maxResults) break;
      }
    }
    rl.close(); fileStream.destroy();
  } catch { /* skip */ }
  return results;
}

export const searchContent: ToolDefinition = {
  name: "grep",
  description: "在文件内容中搜索文本或正则表达式，支持目录递归搜索和上下文显示",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词或正则表达式" },
      path: { type: "string", description: "文件或目录路径，默认当前目录" },
      glob: { type: "string", description: "限定文件类型，如 *.ts" },
      ignoreCase: { type: "boolean", description: "忽略大小写，默认 true" },
      context: { type: "number", description: "上下文行数，默认 0" },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? "");
    const searchPath = resolvePath(String(args.path ?? "."));
    const glob = args.glob ? String(args.glob) : null;
    const ignoreCase = args.ignoreCase !== false;
    const contextLines = Number(args.context ?? 0);
    let regex: RegExp;
    try { regex = new RegExp(query, ignoreCase ? "gi" : "g"); } catch { return `错误: 无效的正则表达式 — "${query}"`; }
    const results: string[] = [];
    try {
      const stat = await fsAsync.stat(searchPath);
      const files: string[] = [];
      if (stat.isFile()) files.push(searchPath);
      else await collectFiles(searchPath, glob, files);
      let matchCount = 0;
      for (const fp of files) {
        if (matchCount >= MAX_GREP_RESULTS) { results.push(`... 已达上限 (${MAX_GREP_RESULTS} 条)`); break; }
        const r = await grepFile(fp, regex, contextLines, MAX_GREP_RESULTS - matchCount);
        matchCount += r.length; results.push(...r);
      }
      if (results.length === 0) return `未找到匹配 "${query}" 的结果`;
      return `找到 ${matchCount} 处匹配:\n${results.join("\n")}`;
    } catch (e: any) { return `搜索失败: ${e.message}`; }
  },
};
