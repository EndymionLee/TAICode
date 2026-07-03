/**
 * 工具共享函数
 */
import * as path from "path";

export const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".venv",
  "__pycache__", ".next", ".nuxt", "coverage",
  ".cache", ".idea", ".vscode",
]);

export const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1MB
export const MAX_GREP_RESULTS = 500;

export function resolvePath(inputPath: string, cwd?: string): string {
  if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
  const base = cwd ?? process.env.TAICODE_CWD ?? process.cwd();
  return path.resolve(base, inputPath);
}

export function isIgnoredPath(filePath: string): boolean {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts.some((p) => IGNORE_DIRS.has(p));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
