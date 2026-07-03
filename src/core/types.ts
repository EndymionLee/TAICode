/**
 * 共享类型定义 — 消息、工具、任务状态
 *
 * 直接使用 @langchain/core 的消息类型，与 LangGraph 无缝集成。
 */
import type { BaseMessage } from "@langchain/core/messages";

// ============================================================================
// 工具定义
// ============================================================================

/** JSON Schema 参数定义 */
export interface ToolParameter {
  type: string;
  description?: string;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  items?: { type: string };
}

/** 工具能力等级 */
export type ToolCapability = "read" | "write" | "execute";

/** 工具定义 — 等价于 Python 的 @tool 装饰器生成的结构 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter;
  /** 优先级 (100=语义工具, 1=后备), Router 排序用 */
  priority?: number;
  /** 能力等级 (read=只读, write=写文件, execute=执行命令) */
  capability?: ToolCapability;
  /** 执行工具，返回字符串结果 */
  execute(args: Record<string, unknown>): Promise<string> | string;
}

// ============================================================================
// 任务状态
// ============================================================================

/** 子任务状态 */
export type SubTaskStatus = "pending" | "in_progress" | "running" | "completed" | "failed";

/** 子任务 — Planner 输出的原始结构（含资源标注） */
export interface ResourceTask {
  id: number;
  description: string;
  /** 本任务需要读取的文件/资源路径 */
  reads?: string[];
  /** 本任务会创建或写入的文件/资源路径 */
  writes?: string[];
  /** 本任务会删除的文件/资源路径 */
  deletes?: string[];
}

/** 子任务 — 运行时状态 */
/** 错误分类 — 重试策略依据 */
export interface ErrorClassification {
  category: "llm" | "tool" | "sandbox" | "validation";
  reason: string;
  retriable: boolean;    // 值得原样重试？
  repairable: boolean;   // 可以自动修复后重试？
}

/** 文件状态 — Planner 去重 + 文件漂移追溯 */
export interface FileState {
  created: boolean;       // 是否已创建
  lastTaskId: number;     // 最后操作的任务 ID
  lastAction: "create" | "modify";
  modifiedAt: number;     // Date.now()
}

export interface SubTask {
  id: number;
  description: string;
  status: SubTaskStatus;
  result: string;
  logs?: string[];
  reads?: string[];
  writes?: string[];
  deletes?: string[];
  contract?: Record<string, number>;
}

/**
 * 根据资源标注自动推导任务间依赖关系。
 *
 * 规则:
 *   - a 写入 X, b 读取 X → b 依赖 a
 *   - a 写入 X, b 也写入 X → b 依赖 a (写冲突串行化)
 *   - a 删除 X, b 读取 X → b 依赖 a
 *   - a 写入 X, b 删除 X → b 依赖 a
 *
 * 复杂度 O(n²)，但 n 通常不超过 10-20，无需优化。
 */
export function computeDependencies(
  tasks: ResourceTask[]
): Record<string, number[]> {
  const deps: Record<string, number[]> = {};

  for (let i = 0; i < tasks.length; i++) {
    const a = tasks[i];
    for (let j = i + 1; j < tasks.length; j++) {
      const b = tasks[j];

      const aReads = new Set(a.reads ?? []);
      const aWrites = new Set(a.writes ?? []);
      const aDeletes = new Set(a.deletes ?? []);

      const bReads = new Set(b.reads ?? []);
      const bWrites = new Set(b.writes ?? []);
      const bDeletes = new Set(b.deletes ?? []);

      const hasConflict =
        hasIntersection(aWrites, bReads) ||   // b 读 a 写的
        hasIntersection(aWrites, bWrites) ||  // 写冲突
        hasIntersection(aDeletes, bReads) ||  // b 读 a 删的
        hasIntersection(aWrites, bDeletes);   // b 删 a 写的

      if (hasConflict) {
        const key = String(b.id);
        if (!deps[key]) deps[key] = [];
        deps[key].push(a.id);
      }
    }
  }

  return deps;
}

function hasIntersection(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

/**
 * 拓扑排序 — 按依赖关系排列任务。
 * 无依赖的任务保持原顺序，有依赖的任务排在依赖之后。
 */
export function sortByDependencies(
  tasks: ResourceTask[],
  dependencies: Record<string, number[]>
): SubTask[] {
  const inDegree = new Map<number, number>();
  const adj = new Map<number, number[]>();

  for (const t of tasks) {
    inDegree.set(t.id, 0);
    adj.set(t.id, []);
  }
  for (const [key, deps] of Object.entries(dependencies)) {
    const id = Number(key);
    for (const dep of deps) {
      adj.get(dep)?.push(id);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
    }
  }

  // Kahn 算法
  const queue: number[] = [];
  for (const t of tasks) {
    if (inDegree.get(t.id) === 0) queue.push(t.id);
  }

  const order: number[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const next of adj.get(node) ?? []) {
      const deg = inDegree.get(next)! - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  // 未被排序的（循环依赖）追加到末尾
  const sorted = order.map((id) => tasks.find((t) => t.id === id)!);
  for (const t of tasks) {
    if (!order.includes(t.id)) sorted.push(t);
  }

  return sorted.map((t) => ({
    id: t.id,
    description: t.description,
    status: "pending" as const,
    result: "",
    reads: t.reads,
    writes: t.writes,
    deletes: t.deletes,
  }));
}

/** 队列版任务状态 */
export interface QueueTaskState {
  messages: BaseMessage[];
  userInput: string;
  needDecompose: boolean;
  tasks: SubTask[];
  currentTaskIndex: number;
  currentTaskDescription: string;
  taskStartMsgIndex: number;
  completedTaskResults: string[];
  finalAnswer: string;
}

/** DAG 并行版任务状态 */
export interface ParallelTaskState {
  messages: BaseMessage[];
  userInput: string;
  needDecompose: boolean;
  tasks: SubTask[];
  dependencies: Record<string, number[]>;
  completedTasks: number[];
  taskResults: Record<number, string>;
  taskLogs: Record<number, string[]>;
  finalAnswer: string;
}

// ============================================================================
// 记忆相关类型
// ============================================================================

/** 短期记忆条目 */
export interface MemoryEntry {
  role: "user" | "assistant";
  content: string;
}

/** 语义记忆搜索结果 */
export interface SemanticSearchResult {
  text: string;
  score: number;
}

/** 用户画像 */
export interface PersonaData {
  name: string | null;
  occupation: string | null;
  education: string | null;
  interests: string[];
  expertise: Record<string, string>;
}

/** LLM 配置 */
export interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  temperature?: number;
}

// ============================================================================
// 工具函数
// ============================================================================

// JSON 工具已迁移至 json-utils.ts
export { extractJson, safeJsonParse } from "./json-utils.js";

/** 延时工具 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
