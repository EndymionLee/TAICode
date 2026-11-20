/**
 * File Refs — Unicode 健壮的文件引用提取
 *
 * 替换全系统的脆正则 /([a-zA-Z0-9_-]+\.[a-z]{1,6})/gi:
 *   - 中文/Unicode 文件名 ("计算器.py") 旧正则直接漏配
 *   - 多级扩展名 ("my.test.ts") 旧正则截断成 "my.test"
 *   - 误报 ("v1.2" / "e.g" / "1.5亿") 旧正则部分命中
 *
 * 两级接受策略:
 *   Tier A: 扩展名在常见代码/数据/文档白名单 → 直接接受
 *   Tier B: 未知扩展名 → 名称含 数字/下划线/连字符/非ASCII 字符才接受
 *           (排除 "e.g" 这类纯小写英文缩写误报)
 *
 * 本模块只做内部簿记(文件锁/去重/步数自适应), 不用于限制模型行为。
 */
import * as path from "path";

/** 常见扩展名白名单 — Tier A 直接接受 */
const COMMON_EXTS = new Set([
  // 代码
  "py", "pyw", "ipynb", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "jsonc", "json5",
  "java", "jar", "kt", "kts", "swift", "dart", "c", "h", "cpp", "cc", "cxx", "hpp", "hh",
  "rs", "go", "rb", "php", "pl", "pm", "lua", "r", "jl", "ex", "exs", "erl", "hrl",
  "hs", "clj", "scala", "groovy", "m", "mm", "vue", "svelte", "astro",
  // 脚本/构建
  "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1", "psm1", "mk", "cmake", "gradle",
  "makefile", "dockerfile", "tf", "tfvars", "sql", "prisma",
  // 配置
  "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "properties", "lock", "npmrc",
  "editorconfig", "gitignore", "gitattributes", "babelrc", "eslintrc", "prettierrc",
  // 文档/数据/资源
  "md", "mdx", "txt", "rst", "pdf", "docx", "xlsx", "pptx", "csv", "tsv",
  "html", "htm", "css", "scss", "sass", "less", "styl",
  "xml", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif",
  "mp3", "mp4", "wav", "avi", "mkv", "mov", "woff", "woff2", "ttf", "eot",
  "zip", "tar", "gz", "7z", "rar", "pth", "model", "pth", "onnx", "pkl",
]);

/** 扩展名形态: 字母开头, 字母数字, 1-8 位 */
const EXT_RE = /^[A-Za-z][A-Za-z0-9]{0,7}$/;

/** 名称中含这些特征时, 未知扩展名也可接受 (Tier B) */
const NAME_MARKER_RE = /[0-9_\-\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Token 边界: 空白 + 中英文标点 + 引号包裹符 */
const TOKEN_SPLIT_RE = /[\s,;:!?()[\]{}<>"'`|*+=~^$#@&%\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001\u300A\u300B\uFF08\uFF09\u3010\u3011\u2026\u201C\u201D\u2018\u2019]+/;

/** 清理 token 两端的路径无关杂字符 */
function cleanToken(token: string): string {
  return token.replace(/^[\u201C\u201D\u2018\u2019'"`*(<[{]+|[\u201C\u201D\u2018\u2019'"`*)>\\]\\.]+$|[,;:.。；：，]+$/g, "");
}

/** 判断单个 token 是否是文件引用, 是则返回 basename */
function matchFileRef(token: string): string | null {
  // 路径 → 取 basename (与旧行为一致: "src/utils/helper.ts" → "helper.ts")
  const basename = path.basename(token.replace(/\\/g, "/"));
  if (!basename || basename === "." || basename === "..") return null;

  const lastDot = basename.lastIndexOf(".");
  if (lastDot <= 0) return null; // 无扩展名或以 . 开头 (.gitignore 这类交给白名单特殊处理)

  const name = basename.slice(0, lastDot);
  const ext = basename.slice(lastDot + 1);

  if (!EXT_RE.test(ext)) return null; // "v1.2" / "1.5亿" 在此排除
  if (name.length === 0) return null;

  const extLower = ext.toLowerCase();
  // 无扩展名配置文件 (Dockerfile/Makefile/.gitignore 等)
  const noExtKnown = /^(dockerfile|makefile|rakefile|gemfile|procfile|license|readme)$/i.test(basename);
  if (noExtKnown) return basename;

  if (COMMON_EXTS.has(extLower)) return basename; // Tier A
  // Tier B: 未知扩展名, 名称需有数字/下划线/连字符/非ASCII 特征
  if (name.length >= 2 && NAME_MARKER_RE.test(name)) return basename;
  return null;
}

/** 从文本提取文件引用 (basename, 保留原大小写, 按出现顺序去重) */
export function extractFileRefs(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of text.split(TOKEN_SPLIT_RE)) {
    const token = cleanToken(raw);
    if (!token || token.length > 260) continue;
    const ref = matchFileRef(token);
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      result.push(ref);
    }
  }
  return result;
}

/** 归一化 key: 小写 + 正斜杠 (与 completedFiles 键空间对齐) */
export function fileKey(name: string): string {
  return name.replace(/\\/g, "/").toLowerCase();
}

/** 提取归一化 key 列表 (文件锁/去重直接用; key 级去重 — "A.py"与"a.py"视为同一文件) */
export function extractFileRefKeys(text: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const ref of extractFileRefs(text)) {
    const k = fileKey(ref);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return keys;
}

/**
 * 判断文件是否已在 completedFiles 中登记。
 * completedFiles 的键是相对路径 ("cc/a.py"), 提取到的是 basename ("a.py") —
 * 旧代码用 basename 直接查键几乎永不命中, 这里补上后缀匹配修复该缺陷。
 */
export function isRegisteredFile(completedFiles: Record<string, unknown>, name: string): boolean {
  const key = fileKey(name);
  if (completedFiles[key] !== undefined) return true;
  const suffix = "/" + key;
  for (const k of Object.keys(completedFiles)) {
    if (k === key || k.endsWith(suffix)) return true;
  }
  return false;
}
