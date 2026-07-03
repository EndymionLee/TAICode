/**
 * DAG 事件驱动并行调度器
 */
import * as os from "os";
import type { SubTask } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { Semaphore } from "./semaphore.js";
import { reactWorker, type WorkerResult } from "./worker.js";
import { events } from "../core/events.js";
import { safeJsonParse } from "../core/json-utils.js";
import { getSandboxInstance } from "../core/tools/registry.js";
import type { ErrorClassification } from "../core/types.js";

const log = createLogger("task:dag");

const MAX_WORKERS = Math.min(8, os.cpus().length || 4);
const workerSemaphore = new Semaphore(MAX_WORKERS);

export { MAX_WORKERS, workerSemaphore };

/** 找出所有依赖已满足的待执行任务 */
function findReadyTasks(
  tasks: SubTask[],
  dependencies: Record<string, number[]>,
  completed: Set<number>
): SubTask[] {
  return tasks.filter((t) => {
    if (t.status !== "pending" && t.status !== "failed") return false;
    const deps = dependencies[String(t.id)];
    if (!deps || deps.length === 0) return true;
    return deps.every((depId) => completed.has(depId));
  });
}

/** 归一化 LLM 输出的依赖格式 */
export function normalizeDependencies(raw: Record<string, unknown>): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const [key, val] of Object.entries(raw)) {
    const numKey = String(Number(key));
    if (typeof val === "number") {
      result[numKey] = [val];
    } else if (typeof val === "string") {
      result[numKey] = val.split(",").map((s) => Number(s.trim())).filter((n) => !isNaN(n));
    } else if (Array.isArray(val)) {
      result[numKey] = (val as any[]).map((v) => typeof v === "number" ? v : Number(v)).filter((n) => !isNaN(n));
    }
  }
  return result;
}

/** BFS 分层统计并行组数 */
export function countParallelGroups(
  tasks: SubTask[],
  dependencies: Record<string, number[]>
): number {
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
  let current = tasks.filter((t) => inDegree.get(t.id) === 0);
  let groups = 0;
  const processed = new Set(current.map((t) => t.id));
  while (current.length > 0) {
    groups++;
    const next: SubTask[] = [];
    for (const node of current) {
      for (const neighbor of adj.get(node.id) ?? []) {
        if (processed.has(neighbor)) continue;
        const deg = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, deg);
        if (deg === 0) {
          processed.add(neighbor);
          next.push(tasks.find((t) => t.id === neighbor)!);
        }
      }
    }
    current = next;
  }
  return groups;
}

/** 合并自动和手动依赖 */
export function mergeDependencies(
  auto: Record<string, number[]>,
  manual: Record<string, number[]>
): Record<string, number[]> {
  const result = { ...auto };
  for (const [key, deps] of Object.entries(manual)) {
    if (!result[key]) {
      result[key] = deps;
    } else {
      result[key] = Array.from(new Set([...result[key], ...deps]));
    }
  }
  return result;
}

/** DAG 事件驱动调度器 */
export class DAGScheduler {
  async execute(
    tasks: SubTask[],
    dependencies: Record<string, number[]>
  ): Promise<{
    tasks: SubTask[];
    completedTasks: number[];
    taskResults: Record<number, string>;
    taskLogs: Record<number, string[]>;
  }> {
    log.info(`DAG 调度: ${tasks.length} 任务, 依赖: ${JSON.stringify(dependencies)}, Worker=${MAX_WORKERS}`);
    events.dag.start(tasks.length, MAX_WORKERS);
    // 重置预算，每批任务独立计数
    getSandboxInstance().reset();

    const completed = new Set<number>();
    const taskResults: Record<number, string> = {};
    const taskLogs: Record<number, string[]> = {};
    const running = new Map<number, Promise<WorkerResult>>();

    const executeTask = async (task: SubTask, workerId: number): Promise<WorkerResult> => {
      // 只传直接依赖的 summary，不是全部结果
      const depIds = dependencies[String(task.id)] ?? [];
      if (depIds.length > 0) {
        const ctxParts: string[] = [];
        for (const did of depIds) {
          const raw = taskResults[did];
          if (!raw) continue;
          const j = safeJsonParse<{ summary?: string; cwd?: string; created?: string[]; deleted?: string[]; modified?: string[] }>(raw);
          if (j?.summary) {
            const cwd = j.cwd ? ` [目录: ${j.cwd}]` : "";
            ctxParts.push(`#${did}: ${j.summary}${cwd}`);
          } else if (j) {
            const acts: string[] = [];
            if (j.created?.length) acts.push(`创建了${j.created.join(",")}`);
            if (j.deleted?.length) acts.push(`删除了${j.deleted.join(",")}`);
            if (j.modified?.length) acts.push(`修改了${j.modified.join(",")}`);
            ctxParts.push(`#${did}: ${acts.length ? acts.join("; ") : raw.slice(0, 100)}`);
          } else {
            ctxParts.push(`#${did}: ${raw.replace(/\n/g, " ").slice(0, 100)}`);
          }
        }
        if (ctxParts.length) task.description = `${task.description}\n\n前置已完成:\n${ctxParts.join("\n")}`;
      }
      events.task.start(task.id, task.description);
      await workerSemaphore.acquire();
      try {
        return await Promise.race([
          reactWorker(task, workerId),
          new Promise<WorkerResult>((_, reject) =>
            setTimeout(() => reject(new Error("任务超时(120s)")), 120_000)
          ),
        ]);
      } finally { workerSemaphore.release(); }
    };

    // 错误分类器 — 同一种失败不应重试
    function classifyWorkerError(error: string | null): ErrorClassification {
      if (!error) return { category: "tool", reason: "未知", retriable: true, repairable: false };
      if (error.includes("幻觉") || error.includes("未调用工具")) {
        return { category: "llm", reason: error, retriable: false, repairable: false };
      }
      if (error.includes("LLM 错误") || error.includes("超时")) {
        return { category: "llm", reason: error, retriable: true, repairable: false };
      }
      if (error.includes("重复思考") || error.includes("重复工具")) {
        return { category: "llm", reason: error, retriable: false, repairable: false };
      }
      if (error.includes("SyntaxError") || error.includes("ImportError") || error.includes("ModuleNotFoundError")) {
        return { category: "validation", reason: error, retriable: false, repairable: true };
      }
      if (error.includes("Sandbox") || error.includes("拒绝")) {
        return { category: "sandbox", reason: error, retriable: false, repairable: false };
      }
      if (error.includes("无活动") || error.includes("步数用尽") || error.includes("不可恢复")) {
        return { category: "tool", reason: error, retriable: false, repairable: false };
      }
      return { category: "tool", reason: error, retriable: true, repairable: false };
    }

    let workerIdCounter = 0;
    const retries = new Map<number, number>();
    const MAX_RETRIES = 2;

    // 文件写锁：同文件同时只有一个 Worker 在写
    const fileLocks = new Set<string>();

    function lockFiles(task: SubTask): boolean {
      // 从任务描述中提取文件名
      const files = task.description.match(/([a-zA-Z0-9_-]+\.[a-z]{1,6})/gi) ?? [];
      for (const f of files) {
        if (fileLocks.has(f.toLowerCase())) return false; // 文件被锁
      }
      for (const f of files) fileLocks.add(f.toLowerCase());
      return true;
    }

    function unlockFiles(task: SubTask): void {
      const files = task.description.match(/([a-zA-Z0-9_-]+\.[a-z]{1,6})/gi) ?? [];
      for (const f of files) fileLocks.delete(f.toLowerCase());
    }

    while (true) {
      const ready = findReadyTasks(tasks, dependencies, completed);
      for (const task of ready) {
        if (running.has(task.id)) continue;
        if (!lockFiles(task)) continue; // 文件被占用，等下一轮
        const r = retries.get(task.id) ?? 0;
        if (r >= MAX_RETRIES) {
          task.status = "failed";
          completed.add(task.id);
          events.task.fail(task.id, `重试${MAX_RETRIES}次仍失败`);
          continue;
        }
        task.status = "running";
        running.set(task.id, executeTask(task, ++workerIdCounter));
      }
      if (running.size === 0) {
        log.info(`DAG 等待: running=0 completed=${completed.size}/${tasks.length}`);
        break;
      }
      log.debug(`DAG 等待: running=${running.size} completed=${completed.size}/${tasks.length}`);

      const { id: doneId, result: workerResult } = await Promise.race(
        Array.from(running.entries()).map(async ([id, p]) => {
          const result = await p;
          return { id, result };
        })
      );
      running.delete(doneId);

      const task = tasks.find((t) => t.id === doneId)!;
      unlockFiles(task);
      if (workerResult.error) {
        const classification = classifyWorkerError(workerResult.error);
        const currentRetries = retries.get(doneId) ?? 0;
        taskLogs[doneId] = workerResult.logs;

        // 不可重试的错误 → 直接失败
        if (!classification.retriable && !classification.repairable) {
          task.status = "failed";
          completed.add(doneId);
          log.warn(`任务 #${doneId} 失败(不可重试): ${workerResult.error} [${classification.category}]`);
          events.task.fail(doneId, workerResult.error);
          taskResults[doneId] = workerResult.result;
        }
        // 可修复的错误 → 标记失败但不消耗重试次数（后续 Validator 可修复）
        else if (classification.repairable && !classification.retriable) {
          task.status = "failed";
          completed.add(doneId);
          log.warn(`任务 #${doneId} 失败(需修复): ${workerResult.error} [${classification.category}]`);
          events.task.fail(doneId, workerResult.error);
          taskResults[doneId] = workerResult.result;
        }
        // 可重试的错误 → 消耗重试次数
        else {
          task.status = "failed";
          task.logs = workerResult.logs;
          const nextRetry = currentRetries + 1;
          retries.set(doneId, nextRetry);
          log.warn(`任务 #${doneId} 失败(重试 ${nextRetry}/${MAX_RETRIES}): ${workerResult.error} [${classification.category}]`);
          events.task.fail(doneId, workerResult.error);
          taskResults[doneId] = workerResult.result;
        }
      } else {
        task.status = "completed";
        task.result = workerResult.result;
        task.logs = workerResult.logs;
        completed.add(doneId);
        taskResults[doneId] = workerResult.result;
        taskLogs[doneId] = workerResult.logs;
        log.info(`任务 #${doneId} 完成, 剩余: ${running.size}`);
        events.task.done(doneId, workerResult.result);
      }
    }

    const succeeded = tasks.filter((t) => t.status === "completed").length;
    const failed = tasks.filter((t) => t.status === "failed").length;
    const skipped = tasks.filter((t) => t.status === "pending").length;
    log.info(`DAG 完成: 成功=${succeeded}, 失败=${failed}, 跳过=${skipped}`);
    events.dag.done(succeeded, failed, skipped);

    return { tasks, completedTasks: Array.from(completed), taskResults, taskLogs };
  }
}
