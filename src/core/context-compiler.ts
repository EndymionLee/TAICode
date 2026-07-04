/**
 * Context Compiler (CC) — 统一上下文编译器
 *
 * 设计理念: 纯内容驱动，不依赖外部分类器。
 * 所有记忆片段按语义重要度评分 → EMA 平滑 → 槽位保护 → 结构化输出。
 *
 * 流程:
 *   收集所有记忆片段
 *     ↓
 *   语义重要度评分 (技术关键词高权重, 闲聊低权重)
 *     ↓
 *   EMA 平滑 (防止每轮剧烈变化)
 *     ↓
 *   永生标记 (身份信息永不衰减)
 *     ↓
 *   槽位保护 (每类记忆保证最少条数)
 *     ↓
 *   结构化输出 [PERSONA][GOAL][CONSTRAINT][KNOWLEDGE][STYLE]
 *
 * 用法:
 *   const cc = new ContextCompiler(logger);
 *   const context = await cc.compile(query, stm, sem, per, imp);
 */
import type { MemoryEntry, SemanticSearchResult, PersonaData } from "./types.js";
import type { Logger } from "./logger.js";

// ============================================================================
// 内部类型
// ============================================================================

interface ContextPiece {
  text: string;
  score: number;
  key: string;
  category: "PERSONA" | "GOAL" | "CONSTRAINT" | "KNOWLEDGE" | "STYLE";
  immortal: boolean;
}

interface ShortTermProvider {
  toText(maxTurns?: number): string;
}

interface SemanticProvider {
  search(query: string, k: number): Promise<SemanticSearchResult[]>;
}

interface PersonaProvider {
  name: string | null;
  interests: string[];
  expertise: Record<string, string>;
}

interface ImportantProvider {
  /** 获取所有重要记忆条目 */
  getItems(): string[];
}

// ============================================================================
// 槽位配置 — 每类记忆最少保留条数
// ============================================================================

const SLOT_CONFIG: Record<string, number> = {
  PERSONA: 2,
  CONSTRAINT: 1,
  GOAL: 1,
  KNOWLEDGE: 2,
};

const MAX_PIECES = 8;

/** 技术类关键词 — 用于判断记忆片段是否与任务相关 */
const TECH_KEYWORDS = /创建|删除|项目|代码|python|ts|js|配置|架构|修复|写入|读取|新建|生成|文件/i;

/** 身份类关键词 — 用于判断是否包含用户身份信息 */
const IDENTITY_PATTERN = /我叫|我是|喜欢|偏好|习惯|经常|总是/i;

/** 硬规则关键词 — 安全约束类 */
const HARD_RULE_PATTERN = /安全|禁止|不允许|必须/i;

/** 风格类关键词 — 语气/风格偏好 */
const STYLE_PATTERN = /风格|语气|可爱|简洁|温柔/i;

/** 任务类关键词 — 用于判断 query 是否偏任务 */
const TASK_QUERY_PATTERN = /创建|删除|写入|读取|新建|生成|项目|代码|搜索|查找|重命名|移动|执行|文件/;

// ============================================================================
// ContextCompiler
// ============================================================================

export class ContextCompiler {
  /** 历史评分记录（key → 上轮得分），用于 EMA 平滑 */
  private prevScores = new Map<string, number>();
  private readonly SMOOTH_ALPHA = 0.7; // 新分数权重 (0.7*新 + 0.3*旧)
  private log: Logger;

  constructor(logger?: Logger) {
    this.log = logger ?? { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, isDebug: () => false };
  }

  /**
   * 统一上下文编译 — 纯内容驱动, 无 Intent 参数。
   *
   * @param query 当前用户输入（用于语义匹配）
   * @param stm   短期记忆提供者
   * @param sem   语义记忆提供者
   * @param per   画像提供者
   * @param imp   重要记忆提供者
   * @returns 结构化上下文文本
   */
  async compile(
    query: string,
    stm: ShortTermProvider,
    sem: SemanticProvider,
    per: PersonaProvider,
    imp: ImportantProvider,
  ): Promise<string> {
    const tokens = new Set(
      query.toLowerCase().split(/[\s,，。！？、]+/).filter(Boolean)
    );
    const isTaskQuery = TASK_QUERY_PATTERN.test(query);
    const candidates: ContextPiece[] = [];

    // ===== Phase 1: 收集 =====

    // --- 短期记忆 ---
    this._collectShortTerm(candidates, stm, tokens);

    // --- 语义记忆 ---
    await this._collectSemantic(candidates, sem, query, per, tokens);

    // --- 画像 (永生) ---
    this._collectPersona(candidates, per);

    // --- 重要记忆/规则 ---
    this._collectImportant(candidates, imp, isTaskQuery);

    // ===== Phase 2: EMA 平滑 =====
    this._applyEMA(candidates);

    // ===== Phase 3: 槽位保护 + Top-K =====
    const topK = this._selectTopK(candidates);

    // ===== Phase 4: 结构化输出 =====
    return this._compose(topK, query);
  }

  /** 重置 EMA 状态（主要用于测试） */
  resetScores(): void {
    this.prevScores.clear();
  }

  // ========================================================================
  // Phase 1 子步骤
  // ========================================================================

  private _collectShortTerm(
    candidates: ContextPiece[],
    stm: ShortTermProvider,
    tokens: Set<string>,
  ): void {
    let recency = 1.0;
    const lines = stm.toText(5).split("\n");

    for (const line of lines.reverse()) {
      const t = line.trim();
      if (!t || (!t.startsWith("用户:") && !t.startsWith("AI:"))) continue;

      const hits = Array.from(tokens).filter((tk) => t.toLowerCase().includes(tk)).length;
      const isIdentity = IDENTITY_PATTERN.test(t);
      const isTech = TECH_KEYWORDS.test(t);
      const importance = isIdentity ? 1.0 : isTech ? 0.9 : Math.max(0.3, recency);

      candidates.push({
        text: t,
        score: (0.3 + hits * 0.15 + recency * 0.1) * importance,
        key: `stm:${t.slice(0, 40)}`,
        category: t.startsWith("用户:") ? "GOAL" : "KNOWLEDGE",
        immortal: isIdentity,
      });
      recency *= 0.85;
    }
  }

  private async _collectSemantic(
    candidates: ContextPiece[],
    sem: SemanticProvider,
    query: string,
    per: PersonaProvider,
    tokens: Set<string>,
  ): Promise<void> {
    // 构建画像关键词集合（用于去重 — 跳过画像已覆盖的内容）
    const personaKeys = new Set(
      [per.name, ...per.interests, ...Object.keys(per.expertise)]
        .filter(Boolean)
        .map((s) => s!.toLowerCase())
    );

    const semResults = await sem.search(query, 10);
    for (const r of semResults) {
      // 跳过画像已覆盖的内容，避免双重信号
      if (Array.from(personaKeys).some((pk) => r.text.toLowerCase().includes(pk as string))) {
        continue;
      }

      const isTask = TECH_KEYWORDS.test(r.text.toLowerCase());
      const weight = isTask ? 0.85 : 0.4; // 技术历史保留, 闲聊衰减
      candidates.push({
        text: r.text.slice(0, 200),
        score: r.score * weight,
        key: `sem:${r.text.slice(0, 60)}`,
        category: "KNOWLEDGE",
        immortal: false,
      });
    }
  }

  private _collectPersona(
    candidates: ContextPiece[],
    per: PersonaProvider,
  ): void {
    // 姓名 — 永生
    if (per.name) {
      candidates.push({
        text: `姓名: ${per.name}`,
        score: 10,
        key: "p:name",
        category: "PERSONA",
        immortal: true,
      });
    }

    // 兴趣 — 永生
    if (per.interests.length > 0) {
      candidates.push({
        text: `兴趣: ${per.interests.join(", ")}`,
        score: 5,
        key: "p:interests",
        category: "PERSONA",
        immortal: true,
      });
    }

    // 技术专长 — 永生
    const exp = Object.entries(per.expertise)
      .map(([k, v]) => `${k}(${v})`)
      .join(", ");
    if (exp) {
      candidates.push({
        text: `技术: ${exp}`,
        score: 5,
        key: "p:expertise",
        category: "PERSONA",
        immortal: true,
      });
    }
  }

  private _collectImportant(
    candidates: ContextPiece[],
    imp: ImportantProvider,
    isTaskQuery: boolean,
  ): void {
    for (const item of imp.getItems()) {
      const isHard = HARD_RULE_PATTERN.test(item);
      const isStyle = STYLE_PATTERN.test(item);
      // 任务查询时 STYLE 自动降权到 0.1
      const score = isHard ? 10 : isTaskQuery ? 0.1 : 1.0;

      candidates.push({
        text: `${isHard ? "⚠️ " : ""}${item}`,
        score,
        key: `rule:${item}`,
        category: isHard ? "CONSTRAINT" : "STYLE",
        immortal: isHard,
      });
    }
  }

  // ========================================================================
  // Phase 2: EMA 平滑
  // ========================================================================

  private _applyEMA(candidates: ContextPiece[]): void {
    for (const c of candidates) {
      if (c.immortal) continue; // 永生标记跳过平滑

      const prev = this.prevScores.get(c.key);
      if (prev !== undefined) {
        c.score = this.SMOOTH_ALPHA * c.score + (1 - this.SMOOTH_ALPHA) * prev;
      }
      this.prevScores.set(c.key, c.score);
    }

    // 衰减未出现的记忆
    for (const key of this.prevScores.keys()) {
      if (!candidates.some((c) => c.key === key)) {
        const old = this.prevScores.get(key)!;
        if (old < 0.05) {
          this.prevScores.delete(key);
        } else {
          this.prevScores.set(key, old * 0.4);
        }
      }
    }
  }

  // ========================================================================
  // Phase 3: 槽位保护 + Top-K 选择
  // ========================================================================

  private _selectTopK(candidates: ContextPiece[]): ContextPiece[] {
    // 按类别分组
    const byCat = new Map<string, ContextPiece[]>();
    for (const c of candidates) {
      const group = byCat.get(c.category) ?? [];
      group.push(c);
      byCat.set(c.category, group);
    }

    // 每组按分数降序
    for (const items of byCat.values()) {
      items.sort((a, b) => b.score - a.score);
    }

    // 槽位保护: 每类至少保留 SLOT_CONFIG 条
    const selected: ContextPiece[] = [];
    for (const [cat, minCount] of Object.entries(SLOT_CONFIG)) {
      const items = byCat.get(cat);
      if (items) {
        for (let i = 0; i < Math.min(minCount, items.length); i++) {
          selected.push(items[i]);
        }
      }
    }

    // 剩余名额按全局分数填充
    const remaining = [...candidates]
      .filter((c) => !selected.includes(c))
      .sort((a, b) => b.score - a.score);

    for (const c of remaining) {
      if (selected.length >= MAX_PIECES) break;
      selected.push(c);
    }

    return selected;
  }

  // ========================================================================
  // Phase 4: 结构化输出
  // ========================================================================

  private _compose(items: ContextPiece[], query: string): string {
    const cats: Record<string, string[]> = {
      PERSONA: [],
      GOAL: [],
      CONSTRAINT: [],
      KNOWLEDGE: [],
      STYLE: [],
    };

    const seen = new Set<string>(); // 文本去重

    for (const { text, category } of items) {
      const key = text.slice(0, 80).trim();
      if (seen.has(key)) continue;
      seen.add(key);

      switch (category) {
        case "PERSONA":
          cats.PERSONA.push(`• ${text}`);
          break;
        case "GOAL":
          cats.GOAL.push(text.replace("用户: ", ""));
          break;
        case "CONSTRAINT":
          cats.CONSTRAINT.push(`• ${text}`);
          break;
        case "STYLE":
          cats.STYLE.push(`- ${text}`);
          break;
        case "KNOWLEDGE":
          cats.KNOWLEDGE.push(text.length > 150 ? text.slice(0, 150) + "..." : text);
          break;
      }
    }

    // 组装输出
    const sections: string[] = [];

    if (cats.PERSONA.length > 0) {
      sections.push(`[PERSONA]\n${cats.PERSONA.join("\n")}`);
    }
    if (cats.GOAL.length > 0) {
      sections.push(`[GOAL]\n当前: ${query}\n${cats.GOAL.join("\n")}`);
    }
    if (cats.CONSTRAINT.length > 0) {
      sections.push(`[CONSTRAINT]\n${cats.CONSTRAINT.join("\n")}`);
    }
    if (cats.KNOWLEDGE.length > 0) {
      sections.push(`[KNOWLEDGE]\n${cats.KNOWLEDGE.slice(0, 5).join("\n")}`);
    }
    if (cats.STYLE.length > 0) {
      sections.push(`[STYLE]\n${cats.STYLE.join("\n")}`);
    }

    const result = sections.join("\n\n");

    this.log.info(
      `编译上下文: P${cats.PERSONA.length} G${cats.GOAL.length} C${cats.CONSTRAINT.length} K${cats.KNOWLEDGE.length} S${cats.STYLE.length}`
    );

    return result;
  }
}
