/**
 * Cache Telemetry — LLM 前缀缓存命中遥测
 *
 * DeepSeek 自动前缀缓存按 64-token 块计价 (命中输入 ~1/10 价)。
 * 本模块统一采集 prompt_cache_hit_tokens / prompt_cache_miss_tokens,
 * 会话/任务结束输出命中率报告 — 没有度量就没有优化。
 *
 * 采集点:
 *   - adapter.chat()            → Gate / ifPlan / 汇总 / 记忆提取
 *   - worker / reactAgent       → invoke 返回 AIMessage 后调 recordAIMessage()
 */
import { createLogger } from "../logger.js";

const log = createLogger("llm:cache");

export interface CacheUsage {
  hit: number;      // prompt_cache_hit_tokens
  miss: number;     // prompt_cache_miss_tokens
  output: number;   // completion_tokens
}

export interface CacheReport {
  calls: number;
  hitTokens: number;
  missTokens: number;
  outputTokens: number;
  totalInputTokens: number;
  /** 命中率 = hit / (hit + miss), 无输入时为 null */
  hitRate: number | null;
}

interface Stats extends CacheReport { callsWithUsage: number }

let stats: Stats = { calls: 0, hitTokens: 0, missTokens: 0, outputTokens: 0, totalInputTokens: 0, hitRate: null, callsWithUsage: 0 };

/**
 * 从 LangChain AIMessage 提取缓存字段。
 * 实测 (probe⑨, @langchain/openai 0.3) 三条路径:
 *   ① usage_metadata.input_token_details.cache_read — 标准化的 DeepSeek 命中数 (首选)
 *   ② response_metadata.tokenUsage / usage — OpenAI 原始对象 (camelCase! 不是 token_usage)
 *   ③ response_metadata.token_usage — 旧版 snake_case 兼容
 */
export function extractCacheUsage(msg: unknown): CacheUsage | null {
  const m = msg as any;

  // 路径①: LangChain 标准化 usage_metadata
  const um = m?.usage_metadata;
  if (um && typeof um.input_tokens === "number") {
    const prompt = Number(um.input_tokens ?? 0);
    const output = Number(um.output_tokens ?? 0);
    if (prompt === 0 && output === 0) return null;
    const hit = Number(um.input_token_details?.cache_read ?? 0);
    return { hit, miss: Math.max(0, prompt - hit), output };
  }

  // 路径②③: response_metadata 原始 usage (camelCase / snake_case)
  const raw = m?.response_metadata?.tokenUsage ?? m?.response_metadata?.usage ?? m?.response_metadata?.token_usage;
  if (raw && typeof raw.prompt_tokens === "number") {
    const prompt = Number(raw.prompt_tokens ?? 0);
    const hit = Number(raw.prompt_cache_hit_tokens ?? 0);
    const output = Number(raw.completion_tokens ?? 0);
    if (prompt === 0 && output === 0) return null;
    return { hit, miss: Math.max(0, prompt - hit), output };
  }

  return null;
}

export function recordCacheUsage(usage: CacheUsage | null, caller = "?"): void {
  stats.calls++;
  if (!usage) return;
  stats.callsWithUsage++;
  stats.hitTokens += usage.hit;
  stats.missTokens += usage.miss;
  stats.outputTokens += usage.output;
  log.debug(`缓存: ${caller} hit=${usage.hit} miss=${usage.miss} out=${usage.output}`);
}

/** 便捷入口: 传 AIMessage, 内部提取并记录 */
export function recordAIMessage(msg: unknown, caller = "?"): void {
  recordCacheUsage(extractCacheUsage(msg), caller);
}

export function getCacheReport(): CacheReport {
  const total = stats.hitTokens + stats.missTokens;
  return {
    calls: stats.calls,
    hitTokens: stats.hitTokens,
    missTokens: stats.missTokens,
    outputTokens: stats.outputTokens,
    totalInputTokens: total,
    hitRate: total > 0 ? stats.hitTokens / total : null,
  };
}

export function resetCacheTelemetry(): void {
  stats = { calls: 0, hitTokens: 0, missTokens: 0, outputTokens: 0, totalInputTokens: 0, hitRate: null, callsWithUsage: 0 };
}

/** 输出人类可读报告 (logger), 并返回报告对象 */
export function logCacheReport(title = "缓存命中报告"): CacheReport {
  const r = getCacheReport();
  const rate = r.hitRate === null ? "N/A" : (r.hitRate * 100).toFixed(1) + "%";
  log.info(`═══ ${title} ═══`);
  log.info(`  调用次数: ${r.calls} (含usage: ${stats.callsWithUsage})`);
  log.info(`  输入tokens: ${r.totalInputTokens} = 命中 ${r.hitTokens} + 未命中 ${r.missTokens}`);
  log.info(`  输出tokens: ${r.outputTokens}`);
  log.info(`  命中率: ${rate}`);
  log.info(`═════════════════`);
  return r;
}
