import fg from "fast-glob";
import type { ToolDefinition } from "../../types.js";
import { resolvePath, IGNORE_DIRS } from "../utils.js";

export const searchFiles: ToolDefinition = {
  name: "find",
  description: "按 glob 模式搜索文件。支持 **/ *.ts {a,b} 等标准 glob 语法。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式，如 **/*.ts, src/**/*.py" },
      path: { type: "string", description: "搜索起始目录，默认当前工作目录" },
    },
    required: ["pattern"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = String(args.pattern ?? "");
    const searchPath = resolvePath(String(args.path ?? "."));
    try {
      const ignorePatterns = Array.from(IGNORE_DIRS).map((d) => `**/${d}/**`);
      const results = await fg(pattern, { cwd: searchPath, onlyFiles: false, ignore: ignorePatterns, markDirectories: true });
      if (results.length === 0) return `未找到匹配 "${pattern}" 的文件`;
      results.sort();
      return `找到 ${results.length} 个匹配:\n${results.map((r) => (r.endsWith("/") ? `📁 ${r}` : `📄 ${r}`)).join("\n")}`;
    } catch (e: any) { return `搜索失败: ${e.message}`; }
  },
};
