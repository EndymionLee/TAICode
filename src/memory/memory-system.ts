/**
 * Memory System — 四种记忆系统 (短期 / 语义 / 画像 / 重要)
 *
 * 设计原则:
 *   1. embedding 失败时有真实 fallback（关键词匹配）
 *   2. 写入串行执行，防止错误被并发吞掉
 *   3. 向量存储防污染（null/空向量不存储）
 */
import * as fsAsync from "fs/promises";
import * as path from "path";
import type { LLMClient } from "../core/llm.js";
import { extractJson, safeJsonParse } from "../core/types.js";
import type { MemoryEntry, SemanticSearchResult, PersonaData } from "../core/types.js";
import { ContextCompiler } from "../core/context-compiler.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("memory");

// ============================================================================
// 工具函数（全部异步）
// ============================================================================

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fsAsync.mkdir(dirPath, { recursive: true });
  } catch { /* ignore */ }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    await fsAsync.access(filePath);
    const content = await fsAsync.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fsAsync.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ============================================================================
// 1. ShortTermMemory — 滑动窗口对话缓冲
// ============================================================================

export class ShortTermMemory {
  private messages: MemoryEntry[] = [];
  private maxLen: number;

  constructor(maxLen: number = 10) {
    this.maxLen = maxLen;
  }

  add(role: "user" | "assistant", content: string): void {
    this.messages.push({ role, content });
    if (this.messages.length > this.maxLen) {
      this.messages = this.messages.slice(-this.maxLen);
    }
  }

  addTurn(userMsg: string, assistantMsg: string): void {
    this.add("user", userMsg);
    this.add("assistant", assistantMsg);
  }

  getAll(): MemoryEntry[] {
    return [...this.messages];
  }

  toText(maxTurns: number = 5): string {
    const recent = this.messages.slice(-maxTurns * 2);
    if (recent.length === 0) return "";
    const lines: string[] = [];
    for (let i = 0; i < recent.length; i += 2) {
      if (recent[i]?.role === "user") lines.push(`用户: ${recent[i].content}`);
      if (recent[i + 1]?.role === "assistant") lines.push(`AI: ${recent[i + 1].content}`);
    }
    return lines.join("\n");
  }

  get count(): number {
    return this.messages.length;
  }

  async save(filePath: string): Promise<void> {
    await writeJsonFile(filePath, this.messages);
  }

  async load(filePath: string): Promise<void> {
    this.messages = await readJsonFile<MemoryEntry[]>(filePath, []);
    if (this.messages.length > this.maxLen) {
      this.messages = this.messages.slice(-this.maxLen);
    }
  }
}

// ============================================================================
// 2. SemanticMemory — 全量历史向量搜索（含 fallback）
// ============================================================================

interface SemanticStore {
  texts: string[];
  vectors: number[][];
}

export class SemanticMemory {
  private texts: string[] = [];
  private vectors: number[][] = [];
  private embedFn: (text: string) => Promise<number[] | null>;

  constructor(embedFn: (text: string) => Promise<number[] | null>) {
    this.embedFn = embedFn;
  }

  /** 添加文本，防污染 */
  async add(text: string): Promise<void> {
    if (!text || text.trim().length === 0) return;
    try {
      const vec = await this.embedFn(text);
      if (!vec || vec.length === 0) {
        log.warn("SemanticMemory.add: embedding 返回空，跳过存储");
        return;
      }
      this.texts.push(text);
      this.vectors.push(vec);
    } catch (e) {
      log.warn("SemanticMemory.add 失败，跳过:", (e as Error).message);
    }
  }

  /** 混合搜索：embedding 优先，失败时关键词 fallback */
  async search(query: string, k: number = 3): Promise<SemanticSearchResult[]> {
    if (this.texts.length === 0) return [];

    const queryVec = await this.embedFn(query).catch(() => null);

    // 路径 1: embedding 可用 → 余弦相似度
    if (queryVec && queryVec.length > 0) {
      log.info(`语义搜索(向量): "${query.slice(0, 30)}" → ${Math.min(k, this.texts.length)}/${this.texts.length} 结果`);
      const qNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0));
      if (qNorm === 0) return this.keywordSearch(query, k);

      const scored: SemanticSearchResult[] = [];
      for (let i = 0; i < this.vectors.length; i++) {
        const vec = this.vectors[i];
        // 防御：维度不匹配跳过
        if (!vec || vec.length !== queryVec.length) continue;
        const dot = vec.reduce((s, v, j) => s + v * queryVec[j], 0);
        const vNorm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        const denom = qNorm * vNorm;
        const score = denom > 0 ? dot / denom : 0;
        if (!isNaN(score)) {
          scored.push({ text: this.texts[i], score });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const topK = scored.slice(0, k);
      if (topK.length > 0) return topK;
    }

    // 路径 2: fallback → 关键词匹配
    log.info(`语义搜索(关键词): "${query.slice(0, 30)}" → ${Math.min(k, this.texts.length)}/${this.texts.length} 结果`);
    return this.keywordSearch(query, k);
  }

  /** 关键词匹配 fallback */
  private keywordSearch(query: string, k: number): SemanticSearchResult[] {
    const lower = query.toLowerCase();
    const scored: SemanticSearchResult[] = [];
    for (const text of this.texts) {
      const textLower = text.toLowerCase();
      if (textLower.includes(lower)) {
        scored.push({ text, score: 0.5 });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  async toContext(query: string, k: number = 5): Promise<string> {
    const results = await this.search(query, k);
    if (results.length === 0) return "";
    return "【语义记忆】\n" + results
      .map((r) => {
        const truncated = r.text.length > 100 ? r.text.slice(0, 100) + "..." : r.text;
        return `  [${r.score.toFixed(2)}] ${truncated}`;
      })
      .join("\n");
  }

  get count(): number {
    return this.texts.length;
  }

  async save(filePath: string): Promise<void> {
    await writeJsonFile(filePath, {
      _meta: { model: "all-MiniLM-L6-v2", dimension: 384, updated: new Date().toISOString() },
      texts: this.texts, vectors: this.vectors,
    });
  }

  async load(filePath: string): Promise<void> {
    const raw = await readJsonFile<any>(filePath, { texts: [], vectors: [] });
    if (raw._meta && raw._meta.dimension !== 384) {
      log.warn(`语义向量维度不匹配(存储=${raw._meta.dimension})，清空重建`);
      this.texts = []; this.vectors = []; return;
    }
    this.texts = raw.texts ?? [];
    this.vectors = raw.vectors ?? [];
    // 清理历史污染数据
    const clean: number[][] = [];
    const cleanTexts: string[] = [];
    for (let i = 0; i < this.vectors.length; i++) {
      if (this.vectors[i] && this.vectors[i].length > 0 && this.texts[i]) {
        clean.push(this.vectors[i]);
        cleanTexts.push(this.texts[i]);
      }
    }
    this.vectors = clean;
    this.texts = cleanTexts;
  }
}

// ============================================================================
// 3. Persona — LLM 提取用户画像
// ============================================================================

interface PersonaLLMOutput {
  name: string | null;
  occupation: string | null;
  education: string | null;
  interests: string[];
  expertise: Record<string, string>;
}

const PERSONA_PROMPT = `只提取用户明确表达且长期稳定的信息。

不要推测，不要脑补。

不要提取：
- 当前任务
- 一次性行为
- 短期状态
- 临时计划
- AI 回复中的内容。

输出 JSON：

{
  "name": null,
  "occupation": null,
  "education": null,
  "interests": [],
  "expertise": {}
}

规则：

1. name
仅在：
- 我叫X
- 我的名字是X
- 你可以叫我X
- 英文名是X

时提取。

2. interests
只有明确表达长期兴趣、爱好或持续投入时提取。

3. expertise
只有用户明确声称掌握、精通或具有多年经验时提取。

等级：

beginner
intermediate
advanced
expert

4. 无内容返回 null、[]、{}。

用户发言：
{userMsg}`;

export class Persona {
  name: string | null = null;
  occupation: string | null = null;
  education: string | null = null;
  interests: string[] = [];
  expertise: Record<string, string> = {};
  // 时间衰减追踪
  _firstSeen: Record<string, number> = {};
  _lastSeen: Record<string, number> = {};
  static readonly STALE_DAYS = 30;

  async analyze(userMsg: string, llm: LLMClient): Promise<boolean> {
    if (!userMsg.trim()) return false;
    try {
      const response = await llm.chat(
        [{ role: "user", content: PERSONA_PROMPT.replace("{userMsg}", userMsg) } as any],
        { temperature: 0 }
      );
      const json = extractJson(response);
      const parsed = safeJsonParse<PersonaLLMOutput>(json);
      if (!parsed) return false;

      const now = Date.now();
      let changed = false;
      const touch = (key: string) => {
        if (!this._firstSeen[key]) this._firstSeen[key] = now;
        this._lastSeen[key] = now;
      };

      if (parsed.name && parsed.name !== this.name) { this.name = parsed.name; changed = true; }
      if (parsed.occupation && parsed.occupation !== this.occupation) { this.occupation = parsed.occupation; changed = true; }
      if (parsed.education && parsed.education !== this.education) { this.education = parsed.education; changed = true; }
      for (const interest of parsed.interests ?? []) {
        if (interest && !this.interests.includes(interest)) {
          this.interests.push(interest);
          changed = true;
        }
        if (interest) touch(`interest:${interest}`);
      }
      for (const [field, level] of Object.entries(parsed.expertise ?? {})) {
        if (field && level && this.expertise[field] !== level) {
          this.expertise[field] = level;
          changed = true;
        }
        if (field) touch(`expertise:${field}`);
      }

      // 清理过期条目
      const cutoff = now - Persona.STALE_DAYS * 86400_000;
      const staleInterests = this.interests.filter((i) => (this._lastSeen[`interest:${i}`] || 0) < cutoff);
      if (staleInterests.length > 0) {
        this.interests = this.interests.filter((i) => !staleInterests.includes(i));
        changed = true;
      }

      return changed;
    } catch (e) {
      log.warn("Persona.analyze 失败:", (e as Error).message);
      return false;
    }
  }

  toText(): string {
    const cutoff = Date.now() - Persona.STALE_DAYS * 86400_000;
    const activeInterests = this.interests.filter((i) => (this._lastSeen[`interest:${i}`] || 0) >= cutoff);
    const activeExpertise: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.expertise)) {
      if ((this._lastSeen[`expertise:${k}`] || 0) >= cutoff) activeExpertise[k] = v;
    }

    const parts: string[] = [];
    if (this.name) parts.push(`姓名: ${this.name}`);
    if (this.occupation) parts.push(`职业: ${this.occupation}`);
    if (this.education) parts.push(`学历: ${this.education}`);
    if (activeInterests.length > 0) parts.push(`兴趣: ${activeInterests.join(", ")}`);
    if (Object.keys(activeExpertise).length > 0) {
      parts.push(`专业: ${Object.entries(activeExpertise).map(([k, v]) => `${k}(${v})`).join(", ")}`);
    }
    return parts.length > 0 ? "【用户画像-用户特征】\n" + parts.join("\n") : "";
  }

  async save(filePath: string): Promise<void> {
    await writeJsonFile(filePath, {
      name: this.name, occupation: this.occupation, education: this.education,
      interests: this.interests, expertise: this.expertise,
    });
  }

  async load(filePath: string): Promise<void> {
    const data = await readJsonFile<PersonaData>(filePath, {
      name: null, occupation: null, education: null, interests: [], expertise: {},
    });
    this.name = data.name;
    this.occupation = data.occupation;
    this.education = data.education;
    this.interests = data.interests ?? [];
    this.expertise = data.expertise ?? {};
  }
}

// ============================================================================
// 4. ImportantMemory — LLM 提取重要规则/偏好
// ============================================================================

const IMPORTANT_PROMPT = `只分析用户说了什么重要信息。

AI 回复仅用于理解上下文，绝对不要从 AI 回复中提取任何信息。

用户信息由用户画像提取，不需要进行提取。

仅提取未来可能有价值的信息，例如：

- 行为规则（"不要用shell做文件操作"）
- 格式偏好（"代码注释用中文"）
- 长期决定（"这个项目用TypeScript"）
- 稳定的技术选择（"数据库用Postgres"）

不提取身份、喜好、习惯（由用户画像负责）。

不要提取：

- 当前任务
- 临时状态
- 一次性事件
- 短期计划
- 普通聊天内容

输出 JSON:
{"items": ["用户偏好xxx", "用户习惯xxx"]}

没有则输出:
{"items": []}

用户: {userMsg}
AI回复（仅供理解上下文，不从中提取）: {aiReply}`;

export class ImportantMemory {
  private items: string[] = [];
  private maxItems: number;

  constructor(maxItems: number = 30) {
    this.maxItems = maxItems;
  }

  async extract(userMsg: string, aiReply: string, llm: LLMClient): Promise<string | null> {
    if (!userMsg.trim()) return null;
    try {
      const response = await llm.chat(
        [{ role: "user", content: IMPORTANT_PROMPT.replace("{userMsg}", userMsg).replace("{aiReply}", aiReply) } as any],
        { temperature: 0 }
      );
      const json = extractJson(response);
      const parsed = safeJsonParse<{ items?: string[] }>(json);
      if (!parsed?.items?.length) return null;

      let added = 0;
      for (const item of parsed.items) {
        if (!item || this.items.includes(item)) continue;
        this.items.push(item);
        if (this.items.length > this.maxItems) this.items.shift();
        added++;
      }
      return added > 0 ? parsed.items[0] : null;
    } catch (e) {
      log.warn("ImportantMemory.extract 失败:", (e as Error).message);
      return null;
    }
  }

  get count(): number {
    return this.items.length;
  }

  toText(): string {
    if (this.items.length === 0) return "";
    return "【重要记忆-行为规则】\n" + this.items.map((item) => `  • ${item}`).join("\n");
  }

  async save(filePath: string): Promise<void> {
    await writeJsonFile(filePath, { items: this.items });
  }

  async load(filePath: string): Promise<void> {
    const data = await readJsonFile<{ items: string[] }>(filePath, { items: [] });
    this.items = data.items ?? [];
  }
}

// ============================================================================
// 5. MemorySystem — 编排器
// ============================================================================

const SUMMARIZE_PROMPT = `根据原始记忆提炼与当前问题相关的内容。

输出 JSON:
{"summary": "精炼后的记忆摘要（1-3段自然语言）"}

无相关记忆时:
{"summary": "无相关记忆"}

原始记忆:
{raw}

当前问题: {query}`;

export interface MemorySystemConfig {
  llm: LLMClient;
  personaLLM: LLMClient;
  importantLLM: LLMClient;
  embedFn: (text: string) => Promise<number[] | null>;
  dataDir: string;
}

export class MemorySystem {
  private llm: LLMClient;
  private personaLLM: LLMClient;
  private importantLLM: LLMClient;
  private stm: ShortTermMemory;
  private sem: SemanticMemory;
  private per: Persona;
  private imp: ImportantMemory;
  private dataDir: string;

  /** 上下文稳定性 — 历史评分记录（key → 上轮得分） */
  private prevScores = new Map<string, number>();
  private readonly SMOOTH_ALPHA = 0.7; // 新分数权重 (0.7*新 + 0.3*旧)

  constructor(config: MemorySystemConfig) {
    this.llm = config.llm;
    this.personaLLM = config.personaLLM;
    this.importantLLM = config.importantLLM;
    this.stm = new ShortTermMemory(10);
    this.sem = new SemanticMemory(config.embedFn);
    this.per = new Persona();
    this.imp = new ImportantMemory(30);
    this.dataDir = config.dataDir;
  }

  /** 暴露内部记忆对象（供 Unified Context 分级过滤） */
  get shortTerm() { return this.stm; }
  get semantic() { return this.sem; }
  get persona() { return this.per; }
  get important() { return this.imp; }

  async initialize(): Promise<void> {
    await ensureDir(this.dataDir);
    await Promise.all([
      this.stm.load(path.join(this.dataDir, "shorttermmemory.json")),
      this.sem.load(path.join(this.dataDir, "semanticmemory.json")),
      this.per.load(path.resolve(process.env.TAICODE_CWD ?? process.cwd(), ".TAI", "persona.json")),
      this.imp.load(path.join(this.dataDir, "importantmemory.json")),
    ]);
    log.info(`记忆加载完成: 短期=${this.stm.count}条, 语义=${this.sem.count}条, 画像=${this.per.name ?? "(空)"}, 规则=${this.imp.count}条`);
  }

  /** 写入管线 — 顺序执行，防止并发吞错误 */
  async process(userMsg: string, aiReply: string): Promise<void> {
    const preview = userMsg.slice(0, 40);
    log.info(`记忆写入: "${preview}${userMsg.length > 40 ? "..." : ""}"`);

    // ShortTerm: 同步
    this.stm.addTurn(userMsg, aiReply);
    log.info(`  短期记忆: ${this.stm.count} 条`);

    // Semantic: 只存储重要对话，过滤闲聊噪音
    const semBefore = this.sem.count;
    try {
      const text = `用户: ${userMsg}\nAI: ${aiReply}`;
      // 过滤: 太短、纯数字、纯问候、纯感谢的不存
      const isNoise = text.length < 20
        || /^\d+$/.test(userMsg.trim())
        || /^(你好|hi|hello|hey|嗨|谢谢|thank|再见|bye|好的|ok|嗯|哦|厉害|666|牛)[!！。.]*$/i.test(userMsg.trim())
        || /^(不客气|没关系|好的|收到)[!！。.]*$/i.test(aiReply.trim());
      if (!isNoise) {
        await this.sem.add(text);
        if (this.sem.count > semBefore) {
          log.info(`  语义记忆: ${this.sem.count} 条 (+1)`);
        } else {
          log.debug("  语义记忆: embedding 失败，跳过");
        }
      } else {
        log.debug("  语义记忆: 过滤低价值消息");
      }
    } catch (e) {
      log.warn("  语义记忆写入失败:", (e as Error).message);
    }

    // Persona: LLM 提取
    try {
      const changed = await this.per.analyze(userMsg, this.personaLLM);
      if (changed) log.info(`  用户画像已更新: ${this.per.name ?? "?"} | ${this.per.interests.join(", ")}`);
    } catch (e) {
      log.warn("  画像分析失败:", (e as Error).message);
    }

    // Important: LLM 提取
    try {
      const item = await this.imp.extract(userMsg, aiReply, this.importantLLM);
      if (item) log.info(`  重要记忆: +"${item}" (共${this.imp.count}条)`);
    } catch (e) {
      log.warn("  重要记忆提取失败:", (e as Error).message);
    }
  }

  async collectRaw(query: string): Promise<string> {
    const [stm, sem, per, imp] = await Promise.all([
      Promise.resolve(this.stm.toText(5)),
      this.sem.toContext(query, 5),
      Promise.resolve(this.per.toText()),
      Promise.resolve(this.imp.toText()),
    ]);
    const blocks: string[] = [];
    if (stm) blocks.push(stm);
    if (sem) blocks.push(sem);
    if (per) blocks.push(per);
    if (imp) blocks.push(imp);
    const result = blocks.join("\n\n");
    log.info(`记忆收集: ${blocks.length}/4 区块, ${result.length} 字符 (短:${!!stm} 语:${!!sem} 画:${!!per} 重:${!!imp})`);
    return result;
  }

  async summarize(raw: string, query: string): Promise<string> {
    if (!raw.trim()) {
      log.info("记忆精炼: 无原始记忆，跳过");
      return "";
    }
    try {
      const response = await this.llm.chat(
        [{ role: "user", content: SUMMARIZE_PROMPT.replace("{raw}", raw).replace("{query}", query) } as any],
        { temperature: 0 }
      );
      const json = extractJson(response);
      const parsed = safeJsonParse<{ summary?: string }>(json);
      const result = parsed?.summary ?? response.trim();
      log.info(`记忆精炼: ${raw.length} → ${result.length} 字符`);
      return result;
    } catch (e) {
      log.warn("summarize 失败，返回原始记忆:", (e as Error).message);
      return raw;
    }
  }

  async buildPrompt(query: string): Promise<string> {
    const raw = await this.collectRaw(query);
    if (!raw.trim()) return "你是一个AI助手。";
    const summarized = await this.summarize(raw, query);
    if (!summarized || summarized.includes("无相关记忆")) {
      return "你是一个AI助手。";
    }
    return `你是一个AI助手。\n\n关于当前对话，你可能需要了解以下信息：\n\n${summarized}`;
  }

  async saveAll(): Promise<void> {
    await ensureDir(this.dataDir);
    await Promise.all([
      this.stm.save(path.join(this.dataDir, "shorttermmemory.json")),
      this.sem.save(path.join(this.dataDir, "semanticmemory.json")),
      this.per.save(path.resolve(process.env.TAICODE_CWD ?? process.cwd(), ".TAI", "persona.json")),
      this.imp.save(path.join(this.dataDir, "importantmemory.json")),
    ]);
    log.info(`记忆保存: data/ (短:${this.stm.count} 语:${this.sem.count} 画:${this.per.name ?? "-"} 重:${this.imp.count})`);
  }

  /**
   * 统一加权上下文 — 按相关性动态评分，不硬切 View。
   *
   * 算法:
   *   - 语义记忆: embedding 余弦相似度 (0-1)
   *   - 画像: 关键词命中率
   *   - 规则: 关键词命中率
   *   - 短期: 固定高权重 (近期相关性)
   *
   * Chat 和 Task 共用此方法，不再区分 View。
   */
  /**
   * 统一上下文编译 (Context Execution Compiler)
   *
   * 单一流水线: 收集 → 语义重要度评分 → 去重 → EMA稳定 → Intent权重 → 槽位保护 → 结构化输出
   * 关键改进: 用内容语义判断重要度，替代盲衰减常数。
   */
  /**
   * 统一上下文编译 — 纯内容驱动, 无 Intent 参数。
   *
   * 权重由内容语义决定 (技术→高, 闲聊→低), 不再依赖外部分类。
   */
  async compileContext(query: string): Promise<string> {
    const tokens = new Set(query.toLowerCase().split(/[\s,，。！？、]+/).filter(Boolean));
    const isTaskQuery = /创建|删除|写入|读取|新建|生成|项目|代码|搜索|查找|重命名|移动|执行|文件/.test(query);
    interface Piece { text: string; score: number; key: string; category: string; immortal: boolean }
    const candidates: Piece[] = [];

    // ===== Phase 1: 收集 =====

    // 短期 — 近期对话权重最高
    let recency = 1.0;
    for (const line of this.stm.toText(5).split("\n").reverse()) {
      const t = line.trim();
      if (!t || (!t.startsWith("用户:") && !t.startsWith("AI:"))) continue;
      const hits = Array.from(tokens).filter((tk) => t.toLowerCase().includes(tk)).length;
      const isIdentity = /我叫|我是|喜欢|偏好|习惯|经常|总是/i.test(t);
      const isTech = /创建|删除|项目|代码|python|ts|js|配置|架构|修复/i.test(t);
      const importance = isIdentity ? 2.0 : isTech ? 1.5 : Math.max(0.5, recency);
      const base = 0.5 + hits * 0.2 + recency * 0.3;
      candidates.push({
        text: t, score: base * importance,  // 分数范围 0.25~2.0, 远超语义的 0.1~0.6
        key: `stm:${t.slice(0, 40)}`, category: t.startsWith("用户:") ? "GOAL" : "KNOWLEDGE",
        immortal: isIdentity,
      });
      recency *= 0.8;
    }

    // 语义 — 仅补充, 分数上限 0.5
    const personaKeys = new Set([this.per.name, ...this.per.interests, ...Object.keys(this.per.expertise)].filter(Boolean).map((s) => s!.toLowerCase()));
    const semResults = await this.sem.search(query, 10);
    for (const r of semResults) {
      if (Array.from(personaKeys).some((pk) => r.text.toLowerCase().includes(pk as string))) continue;
      const isTask = /创建|删除|项目|代码|python|ts|js|文件夹/.test(r.text.toLowerCase());
      const weight = isTask ? 0.5 : 0.25; // 技术历史低权, 闲聊更低
      candidates.push({ text: r.text.slice(0, 200), score: Math.min(0.5, r.score * weight), key: `sem:${r.text.slice(0, 60)}`, category: "KNOWLEDGE", immortal: false });
    }

    // 画像
    if (this.per.name) candidates.push({ text: `姓名: ${this.per.name}`, score: 10, key: "p:name", category: "PERSONA", immortal: true });
    if (this.per.interests.length) candidates.push({ text: `兴趣: ${this.per.interests.join(", ")}`, score: 5, key: "p:interests", category: "PERSONA", immortal: true });
    const exp = Object.entries(this.per.expertise).map(([k, v]) => `${k}(${v})`).join(", ");
    if (exp) candidates.push({ text: `技术: ${exp}`, score: 5, key: "p:expertise", category: "PERSONA", immortal: true });

    // 规则
    for (const item of this.imp["items"] as string[]) {
      const isHard = /安全|禁止|不允许|必须/.test(item);
      const isStyle = /风格|语气|可爱|简洁|温柔/.test(item);
      const score = isHard ? 10 : isTaskQuery ? 0.1 : 1.0; // 任务时风格自动降权
      candidates.push({ text: `${isHard ? "⚠️ " : ""}${item}`, score, key: `rule:${item}`, category: isHard ? "CONSTRAINT" : "STYLE", immortal: isHard });
    }

    // ===== Phase 2: EMA =====
    for (const c of candidates) {
      if (c.immortal) continue;
      const prev = this.prevScores.get(c.key);
      if (prev !== undefined) c.score = this.SMOOTH_ALPHA * c.score + (1 - this.SMOOTH_ALPHA) * prev;
      this.prevScores.set(c.key, c.score);
    }
    for (const key of this.prevScores.keys()) {
      if (!candidates.some((c) => c.key === key)) {
        const old = this.prevScores.get(key)!;
        old < 0.05 ? this.prevScores.delete(key) : this.prevScores.set(key, old * 0.4);
      }
    }

    // ===== Phase 3: 槽位 + Top-K =====
    const SLOTS = { "PERSONA": 2, "CONSTRAINT": 1, "GOAL": 1, "KNOWLEDGE": 2 };
    const byCat = new Map<string, Piece[]>();
    for (const c of candidates) {
      if (!byCat.has(c.category)) byCat.set(c.category, []);
      byCat.get(c.category)!.push(c);
    }
    for (const items of byCat.values()) items.sort((a, b) => b.score - a.score);

    const topK: Piece[] = [];
    for (const [cat, minCount] of Object.entries(SLOTS)) {
      const items = byCat.get(cat);
      if (items) for (let i = 0; i < Math.min(minCount, items.length); i++) topK.push(items[i]);
    }
    for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
      if (topK.length >= 8) break;
      if (!topK.includes(c)) topK.push(c);
    }

    return this._compose(topK, query);
  }

  private _compose(items: { text: string; score: number; category: string }[], query: string): string {
    const cats: Record<string, string[]> = { PERSONA: [], GOAL: [], CONSTRAINT: [], KNOWLEDGE: [], STYLE: [] };
    const seen = new Set<string>();  // 去重: 相同文本只出现一次
    for (const { text, category } of items) {
      const key = text.slice(0, 80).trim();
      if (seen.has(key)) continue;
      seen.add(key);

      if (category === "PERSONA") cats.PERSONA.push(`• 用户${text}`);
      else if (category === "GOAL") cats.GOAL.push(text.replace("用户: ", ""));
      else if (category === "CONSTRAINT") cats.CONSTRAINT.push(`• ${text}`);
      else if (category === "STYLE") cats.STYLE.push(`💡 ${text}`);
      else cats.KNOWLEDGE.push(text.length > 150 ? text.slice(0, 150) + "..." : text);
    }

    const sections: string[] = [];
    if (cats.PERSONA.length) sections.push(`[USER PROFILE]  以下描述的是用户，不是你\n${cats.PERSONA.join("\n")}`);
    if (cats.GOAL.length) sections.push(`[GOAL]\n当前: ${query}\n${cats.GOAL.join("\n")}`);
    if (cats.CONSTRAINT.length) sections.push(`[CONSTRAINT]\n${cats.CONSTRAINT.join("\n")}`);
    if (cats.KNOWLEDGE.length) sections.push(`[KNOWLEDGE]\n${cats.KNOWLEDGE.slice(0, 5).join("\n")}`);
    if (cats.STYLE.length) sections.push(`[STYLE]\n${cats.STYLE.join("\n")}`);

    const result = sections.join("\n\n");
    log.info(`编译上下文: P${cats.PERSONA.length} G${cats.GOAL.length} C${cats.CONSTRAINT.length} K${cats.KNOWLEDGE.length} S${cats.STYLE.length}`);
    return result;
  }

  async debug(query: string): Promise<void> {
    const raw = await this.collectRaw(query);
    console.log("\n === 原始记忆 (Raw) ===");
    console.log(raw || "(空)");
    const summarized = await this.summarize(raw, query);
    console.log("\n === 精炼后 (Summarized) ===");
    console.log(summarized || "(空)");
    console.log();
  }
}
