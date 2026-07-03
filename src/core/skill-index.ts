/**
 * Skill Index — 基于 Embedding 的技能 RAG
 *
 * 启动时增量同步: 扫描 src/skills/ → 比较 metadata → 嵌入新/改文件 → 删除废弃向量
 * 检索: 语义搜索 (余弦相似度)
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { createLogger } from "./logger.js";

const log = createLogger("skill-index");

const SKILLS_DIR = path.resolve(process.env.TAICODE_CWD ?? process.cwd(), ".TAI", "skills");
const INDEX_DIR = path.join(SKILLS_DIR, "skill_index");
const META_FILE = path.join(INDEX_DIR, "metadata.json");
const VECTORS_FILE = path.join(INDEX_DIR, "vectors.json");

// ============================================================================
// Types
// ============================================================================

interface SkillMeta {
  [filename: string]: {
    hash: string;
    title: string;
  };
}

interface SkillVectors {
  _meta?: { model: string; dimension: number; updated: string };
  [filename: string]: number[] | any;
}

const EMBED_META = { model: "all-MiniLM-L6-v2", dimension: 384 };

interface SkillEntry {
  name: string;
  title: string;
  content: string;
  vector: number[];
}

let entries: SkillEntry[] = [];
let embedFn: ((text: string) => Promise<number[] | null>) | null = null;
let initialized = false;

// ============================================================================
// Init
// ============================================================================

export function initSkillIndex(embed: (text: string) => Promise<number[] | null>): void {
  embedFn = embed;
}

export async function syncSkillIndex(): Promise<void> {
  if (!embedFn) { log.warn("Skill Index: embedFn 未设置, 跳过同步"); return; }
  if (!fs.existsSync(SKILLS_DIR)) { fs.mkdirSync(SKILLS_DIR, { recursive: true }); }

  ensureDir(INDEX_DIR);
  const meta = readJson<SkillMeta>(META_FILE, {});
  const vectors = readJson<SkillVectors>(VECTORS_FILE, {});
  // 维度兼容检查
  if (vectors._meta && vectors._meta.dimension !== EMBED_META.dimension) {
    log.warn(`向量维度不匹配 (存储=${vectors._meta.dimension}, 当前=${EMBED_META.dimension})，清空重建`);
    for (const k of Object.keys(vectors)) { if (k !== "_meta") delete vectors[k]; }
  }
  vectors._meta = { ...EMBED_META, updated: new Date().toISOString() };

  // 扫描当前文件
  const currentFiles = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
  const currentSet = new Set(currentFiles);
  let changed = 0;

  // === 新增 + 修改 ===
  for (const file of currentFiles) {
    const filePath = path.join(SKILLS_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const hash = sha256(content);
    const title = content.split("\n").find((l) => l.startsWith("# "))?.replace("# ", "") ?? file.replace(".md", "");

    const existing = meta[file];
    if (!existing || existing.hash !== hash) {
      const reason = !existing ? "新增" : "修改";
      log.info(`Skill Index: ${reason} ${file}`);
      const vec = await embedFn!(content);
      if (vec && vec.length > 0) {
        vectors[file] = vec;
        meta[file] = { hash, title };
        changed++;
      }
    }
  }

  // === 删除 ===
  for (const file of Object.keys(meta)) {
    if (!currentSet.has(file)) {
      log.info(`Skill Index: 删除 ${file}`);
      delete meta[file];
      delete vectors[file];
      changed++;
    }
  }

  // === 保存 ===
  if (changed > 0) {
    writeJson(META_FILE, meta);
    writeJson(VECTORS_FILE, vectors);
  }

  // === 加载到内存 ===
  entries = [];
  for (const file of Object.keys(vectors)) {
    const m = meta[file];
    if (!m) continue;
    const filePath = path.join(SKILLS_DIR, file);
    let content = "";
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { continue; }
    entries.push({ name: file.replace(".md", ""), title: m.title, content, vector: vectors[file] });
  }

  initialized = true;
  log.info(`Skill Index: ${entries.length} 个技能就绪 (${changed} 变更)`);
}

// ============================================================================
// Search
// ============================================================================

/** 技能注入最低阈值 (低于此分数不注入 Planner) */
const SKILL_MIN_SCORE = 0.4;

export async function searchSkills(query: string, topK: number = 3): Promise<SkillEntry[]> {
  if (!initialized || entries.length === 0 || !embedFn) return [];

  const queryVec = await embedFn(query);
  if (!queryVec || queryVec.length === 0) return [];

  const qNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0));
  if (qNorm === 0) return [];

  const scored = entries.map((e) => {
    const dot = e.vector.reduce((s, v, i) => s + v * queryVec![i], 0);
    const vNorm = Math.sqrt(e.vector.reduce((s, v) => s + v * v, 0));
    return { entry: e, score: (qNorm * vNorm) > 0 ? dot / (qNorm * vNorm) : 0 };
  });

  scored.sort((a, b) => b.score - a.score);
  const allMatches = scored.filter((s) => s.score > 0);
  const matches = scored.filter((s) => s.score >= SKILL_MIN_SCORE).slice(0, topK);
  const filtered = allMatches.filter((s) => s.score < SKILL_MIN_SCORE);

  if (matches.length > 0) {
    log.info(`Skill 匹配: ${matches.map((m) => `${m.entry.name}(${m.score.toFixed(2)})`).join(", ")}`);
  }
  if (filtered.length > 0) {
    log.info(`Skill 低分跳过: ${filtered.map((m) => `${m.entry.name}(${m.score.toFixed(2)})`).join(", ")} (阈值 ${SKILL_MIN_SCORE})`);
  }
  return matches.map((m) => m.entry);
}

export function listSkills(): string[] {
  return entries.map((e) => `${e.name}: ${e.title}`);
}

// ============================================================================
// Utils
// ============================================================================

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch { /* ignore */ }
  return fallback;
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}
