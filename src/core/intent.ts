/**
 * Intent Classifier — 混合规则 + LLM, 带置信度
 *
 * 置信度:  1.0=规则精确命中  0.9=强信号(问句)  0.7=LLM  0.3=fallback
 *
 * 防误判:
 *   1. 问句优先 (startsWith, 非 includes)
 *   2. 代码生成 ≠ 文件操作
 *   3. simple_task vs complex_task
 *   4. mixed = greeting + task (精确, 非泛化 chat 词)
 *   5. 真 LRU (access 时移到末尾, evict 删首)
 *   6. question_about_task — 知识问答但涉及 task 主题
 */
import { createLogger } from "./logger.js";
import type { LLMClient } from "./llm.js";

const log = createLogger("intent");

export type Intent = "chat" | "simple_task" | "complex_task" | "mixed" | "question_about_task";

export interface IntentResult {
  intent: Intent;
  confidence: number;
}

// ============================================================================
// Signal Detectors
// ============================================================================

const QUESTION_RE = /^(怎么|如何|为什么|什么是|怎样|能不能|可否|请介绍|请解释|解释|介绍|说明)/;
const QUESTION_ANYWHERE = /(怎么|如何|为什么|什么是|怎样|能不能|可否|请介绍|请解释)/;
const GREETING_RE = /^(你好|hi|hello|hey|嗨|早上好|晚上好|下午好|再见|bye|谢谢|thank|ok|好的|没事|嗯|哦)/i;

// 单文件/简单操作 → simple_task
const SIMPLE_TASK_RE = [
  /^(创建|新建|删除|移除|写入|写)\s+\S+\.\w{1,10}$/,
  /^(创建|新建|删除|移除)\s+\S+\/\s*$/,
  /^(ls|pwd|cat|mkdir|touch|rm|mv|cp)\s/,
  /^(读取|打开|查看|显示)\s+\S+/,
  /^find\s/, /^grep\s/,
];

// 中文文件搜索 (搜索/查找 + 文件/目录/代码/txt/md)
const FILE_SEARCH_RE = /(搜索|查找|找).{0,4}(文件|目录|文件夹|代码|\.txt|\.md|\.py|\.ts|\.js)/;

// 复杂项目信号 → complex_task
const COMPLEX_SIGNALS = [
  "搭建", "构建", "开发", "部署",
  "系统", "应用", "平台", "服务", "网站",
  "游戏", "爬虫", "博客", "商城", "后台",
  "多个文件", "一批", "整个项目",
  "build", "deploy", "setup",
];

// 文件操作关键词
const FILE_OP_WORDS = [
  "创建", "新建", "生成", "删除", "移除", "清除",
  "写入", "重命名", "改名", "移动", "复制",
  "create", "delete", "remove", "write", "rename", "move", "copy",
  "mkdir", "touch", "rm ",
];

// ============================================================================
// Rule Classify
// ============================================================================

function ruleClassify(input: string): IntentResult | null {
  const t = input.trim();
  if (!t) return null;

  const lower = t.toLowerCase();

  // 1. 问句 → 判断是否是 task 主题问答 (前缀或句中)
  const hasQuestion = QUESTION_RE.test(t) || QUESTION_ANYWHERE.test(t);
  if (hasQuestion) {
    const hasTaskTopic = FILE_OP_WORDS.some((w) => lower.includes(w))
      || COMPLEX_SIGNALS.some((w) => lower.includes(w))
      || FILE_SEARCH_RE.test(t)
      || /\b(git|docker|npm|pip|node|python|shell|bash)\b/i.test(t);
    return hasTaskTopic
      ? { intent: "question_about_task", confidence: 0.9 }
      : { intent: "chat", confidence: 0.9 };
  }

  // 2. 精确 greeting → chat (除非后面跟了 task)
  if (GREETING_RE.test(t)) {
    const hasTaskAfterGreeting = FILE_OP_WORDS.some((w) => lower.includes(w))
      || COMPLEX_SIGNALS.some((w) => lower.includes(w))
      || FILE_SEARCH_RE.test(t);
    return hasTaskAfterGreeting
      ? { intent: "mixed", confidence: 1.0 }
      : { intent: "chat", confidence: 1.0 };
  }

  const hasTask = FILE_OP_WORDS.some((w) => lower.includes(w))
    || COMPLEX_SIGNALS.some((w) => lower.includes(w))
    || FILE_SEARCH_RE.test(t);
  const hasComplex = COMPLEX_SIGNALS.some((w) => lower.includes(w));

  // 3. 单文件简单操作 → simple_task
  if (SIMPLE_TASK_RE.some((re) => re.test(t))) return { intent: "simple_task", confidence: 1.0 };

  // 4. 中文文件搜索 → simple_task
  if (FILE_SEARCH_RE.test(t)) return { intent: "simple_task", confidence: 1.0 };

  // 5. 复杂项目 → complex_task
  if (hasComplex) return { intent: "complex_task", confidence: 1.0 };

  // 6. 通用文件操作 → complex_task
  if (hasTask) return { intent: "complex_task", confidence: 0.9 };

  return null; // LLM
}

// ============================================================================
// LLM Layer
// ============================================================================

const CLASSIFIER_PROMPT = `判断意图, 只回复一个单词: chat / simple_task / complex_task / mixed / question_about_task
- chat: 对话、闲聊、知识问答
- simple_task: 单文件操作、简单命令、文件搜索
- complex_task: 多文件项目、系统搭建
- mixed: 问候/闲聊+任务
- question_about_task: 询问怎么做某件事(不是要求执行)

输入: {input}
意图:`;

// ============================================================================
// True LRU Cache + TTL (access 时移到末尾, evict 删首, 1h 过期)
// ============================================================================

const MAX_CACHE = 1000;
const CACHE_TTL_MS = 3600_000; // 1 小时
const intentCache = new Map<string, { result: IntentResult; ts: number }>();

function cacheKey(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
}

function cacheGet(key: string): IntentResult | undefined {
  const entry = intentCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    intentCache.delete(key);
    return undefined;
  }
  // 真 LRU: 移到末尾
  intentCache.delete(key);
  intentCache.set(key, entry);
  return entry.result;
}

function cacheSet(key: string, value: IntentResult): void {
  if (intentCache.has(key)) intentCache.delete(key);
  if (intentCache.size >= MAX_CACHE) {
    const first = intentCache.keys().next().value;
    if (first !== undefined) intentCache.delete(first);
  }
  intentCache.set(key, { result: value, ts: Date.now() });
}

// ============================================================================
// Hybrid Classifier
// ============================================================================

export async function classifyIntent(input: string, llm?: LLMClient): Promise<IntentResult> {
  const key = cacheKey(input);
  const cached = cacheGet(key);
  if (cached) return cached;

  // 1. Rule
  const rule = ruleClassify(input);
  if (rule) { cacheSet(key, rule); return rule; }

  // 2. LLM
  if (llm) {
    try {
      const resp = await llm.chat(
        [{ role: "user", content: CLASSIFIER_PROMPT.replace("{input}", input) } as any],
        { temperature: 0 },
      );
      const result = resp.trim().toLowerCase();
      const valid: Intent[] = ["chat", "simple_task", "complex_task", "mixed", "question_about_task"];
      if (valid.includes(result as Intent)) {
        const r: IntentResult = { intent: result as Intent, confidence: 0.7 };
        cacheSet(key, r);
        return r;
      }
    } catch (e) { log.warn("LLM 分类失败:", (e as Error).message); }
  }

  // 3. Fallback
  const fb: IntentResult = { intent: "complex_task", confidence: 0.3 };
  cacheSet(key, fb);
  return fb;
}
