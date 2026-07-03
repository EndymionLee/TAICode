/**
 * React Worker — 单个任务的 ReAct 循环 + 幻觉检测
 *
 * 进度检测: 文件系统快照 diff (唯一可信进度源)
 * 不再依赖日志 grep — 直接比较工具调用前后的文件系统状态
 */
import * as fs from "fs";
import * as path from "path";
import {
  HumanMessage, AIMessage, SystemMessage, ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ToolDefinition, SubTask } from "../core/types.js";
import { sleep, extractJson } from "../core/types.js";
import { createWorkLLM } from "../core/llm.js";
import { deepCloneTools } from "../core/tools/registry.js";
import { createLogger, isFileLoggingEnabled } from "../core/logger.js";
import { Semaphore } from "./semaphore.js";
import { WORKER_SYSTEM_PROMPT } from "./prompts.js";
import { events } from "../core/events.js";
import { newTrace, newSpan, clearSpan, spanPrefix } from "../core/trace.js";

// ============================================================================
// Worker 配置
// ============================================================================

export const MAX_LLM_CONCURRENCY = 5;
export const llmSemaphore = new Semaphore(MAX_LLM_CONCURRENCY);

// ============================================================================
// 幻觉检测
// ============================================================================

function taskNeedsTools(description: string): boolean {
  const keywords = [
    "文件", "创建", "写入", "删除", "读", "写", "搜索", "查询",
    "天气", "计算", "重命名", "移动", "复制",
    "file", "write", "create", "delete", "read",
    "search", "weather", "calculate", "rename",
  ];
  const lower = description.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function validateWorkerResult(task: SubTask, logs: string[]): string | null {
  const desc = task.description;
  const toolCalled = logs.some((l) => l.includes("调用工具:"));

  if (taskNeedsTools(desc) && !toolCalled) {
    return "验证失败: 任务涉及文件/外部操作但未调用任何工具，疑似幻觉";
  }
  if ((desc.includes("写入") || desc.includes("写") || desc.includes("write"))) {
    const quoted = desc.match(/['"](.+?)['"]/g);
    if (quoted) {
      for (const q of quoted) {
        const content = q.slice(1, -1);
        if (content && content.length < 50 && !logs.some((l) => l.includes(content))) {
          return `验证失败: 任务要求写入"${content}"，但执行日志中未确认该内容`;
        }
      }
    }
  }
  if ((desc.includes("创建") || desc.includes("新建") || desc.includes("create")) && !toolCalled) {
    return "验证失败: 任务要求创建文件但未调用任何工具";
  }

  return null;
}

// ============================================================================
// 文件系统快照 — 以真实文件变更为唯一可信进度源
// ============================================================================

const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", ".TAI",
  ".idea", ".vscode", "dist", "build", ".next", ".nuxt",
  "coverage", ".cache",
]);

interface FileEntry { mtime: number; size: number; }
type Snapshot = Record<string, FileEntry>;

async function takeSnapshot(root: string): Promise<Snapshot> {
  const snap: Snapshot = {};
  const stack: string[] = [root];
  let fileCount = 0;
  const MAX_FILES = 5000;
  while (stack.length > 0 && fileCount < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          snap[fullPath.replace(/\\/g, "/")] = { mtime: stat.mtimeMs, size: stat.size };
          fileCount++;
        } catch { /* 文件在读前被删 */ }
      }
    }
  }
  return snap;
}

function countSnapshotDiff(before: Snapshot, after: Snapshot): number {
  let changes = 0;
  // 新增/修改
  for (const [fp, info] of Object.entries(after)) {
    const prev = before[fp];
    if (!prev || prev.mtime !== info.mtime || prev.size !== info.size) changes++;
  }
  // 删除
  for (const fp of Object.keys(before)) {
    if (!after[fp]) changes++;
  }
  return changes;
}

// ============================================================================
// React Worker
// ============================================================================

export interface WorkerResult {
  taskId: number;
  result: string;
  logs: string[];
  error: string | null;
}

/** Worker 输出标准化 — JSON parse 失败时返回 error JSON，永不透传 raw text */
function parseWorkerOutput(result: string, taskDesc?: string, taskId?: number): string {
  // 标准 JSON 结构
  const errorOutput = (reason: string): string => JSON.stringify({
    status: "failed",
    summary: `Worker 输出格式错误: ${reason}`,
    cwd: "",
    created: [], deleted: [], modified: [], read: [],
    error: "输出格式错误",
    task_id: taskId,
  });

  // 尝试提取 JSON（markdown fence + brace counting）
  const extracted = extractJson(result);
  const json = extracted || result;

  let parsed: any;
  try { parsed = JSON.parse(json); }
  catch {
    // JSON 解析失败 → 标准化 error，不透传
    return errorOutput(`无法解析为 JSON: ${result.slice(0, 100)}`);
  }

  // 字段补全
  if (taskId !== undefined) parsed.task_id = taskId;
  if (!parsed.cwd) {
    const firstPath = (parsed.created ?? []).concat(parsed.deleted ?? [], parsed.modified ?? [])[0];
    if (firstPath) parsed.cwd = firstPath.replace(/[/\\][^/\\]*$/, "");
    else if (taskDesc) {
      const m = taskDesc.match(/([A-Z]:\\[^\s，,\\]*)/i);
      parsed.cwd = m ? m[1] : "";
    } else {
      parsed.cwd = "";
    }
  }
  // 确保必需字段存在 + 常见拼写容错
  parsed.status = parsed.status || "failed";
  parsed.summary = typeof parsed.summary === "string" ? parsed.summary
    : typeof parsed.sumary === "string" ? parsed.sumary  // LLM 常见 typo
    : "";
  parsed.created = parsed.created || [];
  parsed.deleted = parsed.deleted || [];
  parsed.modified = parsed.modified || [];
  parsed.read = parsed.read || [];
  parsed.error = parsed.error || null;

  // 硬截断 summary
  if (parsed.summary.length > 120) {
    parsed.summary = parsed.summary.slice(0, 120) + "...";
  }

  return JSON.stringify(parsed);
}

/** React Worker: 执行单个任务的完整 ReAct 循环 */
export async function reactWorker(
  task: SubTask,
  workerId: number,
): Promise<WorkerResult> {
  const tid = task.id;
  const desc = task.description;
  const workerLog = createLogger(`worker-${workerId}`);
  const trace = newTrace();
  workerLog.info(`开始任务 #${tid}: ${desc.slice(0, 60)}`);
  events.worker.start(workerId, desc.slice(0, 60));
  const logs: string[] = [`${spanPrefix(trace)} [Worker-${workerId}] 开始 #${tid}: ${desc}`];

  const allTools = Object.values(deepCloneTools());
  const workerModel = createWorkLLM(allTools);

  // Contract: 函数签名校验
  const contract = (task as any).contract as Record<string, number> | undefined;
  const contractNote = contract && Object.keys(contract).length > 0
    ? `\n\n函数签名约定（必须严格遵守，写完用 shell 验证 arity）:\n${Object.entries(contract).map(([k, v]) => `  ${k}(...${v}个参数)`).join("\n")}\n验证命令: python -c "${Object.entries(contract).map(([k, v]) => `from xxx import ${k}; assert ${k}.__code__.co_argcount == ${v}`).join("; ")}"`
    : "";

  const taskPrompt = `任务: ${desc}${contractNote}`;

  // 自适应步数：按任务复杂度分级
  const complexity = /cnn|transformer|train|model|网络|训练|模型/i.test(desc) ? 3
    : /class |函数|function|算法|algorithm/i.test(desc) ? 2
    : 1;
  const fileCount = (desc.match(/[a-zA-Z0-9_-]+\.[a-z]{1,6}/gi) ?? []).length || 1;
  let maxSteps = Math.min(60, 20 + fileCount * 5 + complexity * 10);

  const messages: BaseMessage[] = [
    new SystemMessage(WORKER_SYSTEM_PROMPT),
    new HumanMessage(taskPrompt),
  ];

  let toolsCalled = false;
  let lastError = "";
  let sameErrorCount = 0;
  let noProgressSteps = 0;

  // 四层活动/死循环检测
  let lastToolKey = "";           // "toolName:argsHash"
  let repeatToolCount = 0;
  const MAX_REPEAT_TOOL = 6;      // 同工具+同参数 ×6 → 死循环
  let lastResponseContent = "";
  let repeatResponseCount = 0;
  const MAX_REPEAT_RESPONSE = 3;  // 相同 LLM 输出 ×3 → 思考循环

  // 工作区路径 + 初始快照
  const WORKSPACE_DIR = (process.env.TAICODE_CWD ?? process.cwd()).replace(/\\/g, "/");
  workerLog.info(`快照: 开始扫描 ${WORKSPACE_DIR}`);
  let lastSnapshot: Snapshot;
  try {
    lastSnapshot = await Promise.race([
      takeSnapshot(WORKSPACE_DIR),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("快照超时(30s)")), 30_000)
      ),
    ]);
    workerLog.info(`快照: 完成, ${Object.keys(lastSnapshot).length} 个文件`);
  } catch (e) {
    workerLog.warn(`快照失败: ${(e as Error).message}，使用空快照`);
    lastSnapshot = {};
  }

  // 硬心跳 — 绕过 logger，直接 appendFileSync
  const hbFile = (process.env.TAICODE_CWD ?? process.cwd()) + "/.TAI/logs/heartbeat.log";
  const heartbeat = setInterval(() => {
    if (!isFileLoggingEnabled()) return;
    try { fs.appendFileSync(hbFile, `${new Date().toISOString()} worker=${workerId} step=${step}\n`); } catch {}
  }, 3000);

  try {
  for (var step = 0; step < maxSteps; step++) {
    // 步数快用完 + 有进度 → 自动续
    if (step >= maxSteps - 3 && maxSteps < 100 && noProgressSteps < 3) {
      maxSteps += 15;
      workerLog.info(`步数自动续期 +15 → ${maxSteps}`);
    }

    // 每步一个 span — 关联本步内所有日志/工具调用
    newSpan(trace, `step-${step}`);
    events.task.progress(tid, step, step === 0 ? "思考中" : `第${step}步`);

    // LLM 调用 (带重试 + 限流 + 90s 超时)
    let response: AIMessage | null = null;
    const LLM_TIMEOUT_MS = 90_000;
    for (let retry = 0; retry < 3; retry++) {
      try {
        await llmSemaphore.acquire();
        try {
          const result = await Promise.race([
            workerModel.invoke(messages) as Promise<AIMessage>,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`LLM 超时(${LLM_TIMEOUT_MS / 1000}s)`)), LLM_TIMEOUT_MS)
            ),
          ]);
          response = result instanceof AIMessage ? result : new AIMessage({
            content: typeof (result as any).content === "string" ? (result as any).content : "",
            tool_calls: (result as any).tool_calls,
          });
        } finally { llmSemaphore.release(); }
        break;
      } catch (e) {
        const errMsg = (e as Error).message;
        logs.push(`[Worker-${workerId}] LLM 失败 (重试 ${retry + 1}/3): ${errMsg}`);
        if (retry < 2) await sleep(Math.pow(2, retry) * 1000);
        else return { taskId: tid, result: parseWorkerOutput("", desc, tid), logs, error: `LLM 错误: ${errMsg}` };
      }
    }

    if (!response) return { taskId: tid, result: parseWorkerOutput("", desc, tid), logs, error: "LLM 响应为空" };
    messages.push(response);

    // 🔧 重复回复检测 — LLM 连续输出相同内容 ×3 → 思考循环
    const responseText = typeof response.content === "string" ? response.content.trim() : "";
    if (responseText) {
      if (responseText === lastResponseContent) {
        repeatResponseCount++;
        if (repeatResponseCount >= MAX_REPEAT_RESPONSE) {
          workerLog.warn(`重复思考循环: LLM 连续 ${repeatResponseCount} 次输出相同内容`);
          return {
            taskId: tid,
            result: parseWorkerOutput(JSON.stringify({
              status: "failed",
              summary: `LLM 陷入思考循环，连续${repeatResponseCount}次输出相同内容`,
              created: [], deleted: [], modified: [],
              error: "重复思考",
            }), desc, tid),
            logs,
            error: "重复思考循环",
          };
        }
      } else {
        lastResponseContent = responseText;
        repeatResponseCount = 1;
      }
    }

    if (!response.tool_calls || response.tool_calls.length === 0) {
      if (!toolsCalled && taskNeedsTools(desc)) {
        return { taskId: tid, result: parseWorkerOutput(response.content as string || "", desc, tid), logs, error: "幻觉: 未调用工具" };
      }
      logs.push(`[Worker-${workerId}] 任务 #${tid} 完成 (${step + 1} 步)`);
      const validationError = validateWorkerResult(task, logs);
      if (validationError) {
        return { taskId: tid, result: parseWorkerOutput(response.content as string || "", desc, tid), logs, error: validationError };
      }
      workerLog.info(`worker 退出: reason=完成 steps=${step + 1}/${maxSteps}`);
      return { taskId: tid, result: parseWorkerOutput(response.content as string || "", desc, tid), logs, error: null };
    }

    // 执行工具调用
    toolsCalled = true;
    for (const tc of response.tool_calls) {
      const toolName = tc.name as string;
      const args = (tc.args ?? {}) as Record<string, unknown>;
      logs.push(`[Worker-${workerId}] 调用工具: ${toolName}(${JSON.stringify(args)})`);

      // 🔧 重复工具检测 — 同工具+同参数 ×6 → 死循环
      const toolKey = `${toolName}:${JSON.stringify(args)}`;
      if (toolKey === lastToolKey) {
        repeatToolCount++;
        if (repeatToolCount >= MAX_REPEAT_TOOL) {
          workerLog.warn(`重复工具循环: ${toolName} ×${repeatToolCount}`);
          return {
            taskId: tid,
            result: parseWorkerOutput(JSON.stringify({
              status: "failed",
              summary: `死循环: 连续${repeatToolCount}次调用 ${toolName}(${JSON.stringify(args).slice(0, 100)})`,
              created: [], deleted: [], modified: [],
              error: "重复工具",
            }), desc, tid),
            logs,
            error: `重复工具循环: ${toolName}`,
          };
        }
      } else {
        lastToolKey = toolKey;
        repeatToolCount = 1;
      }

      try {
        const tool = allTools.find((t: any) => t.name === toolName);
        if (tool) {
          const result = await tool.execute(args);
          logs.push(`[Worker-${workerId}] 工具结果: ${result.slice(0, 200)}`);
          if (/ImportError|SyntaxError|ModuleNotFoundError|IndentationError/i.test(result)) {
            if (result === lastError) {
              sameErrorCount++;
              if (sameErrorCount >= 2) {
                return { taskId: tid, result: parseWorkerOutput(result, desc, tid), logs, error: `不可恢复错误: ${result.slice(0, 200)}` };
              }
            } else {
              lastError = result;
              sameErrorCount = 1;
            }
          }
          messages.push(new ToolMessage({ content: result, tool_call_id: tc.id!, name: toolName }));
        } else {
          logs.push(`[Worker-${workerId}] 未知工具: ${toolName}`);
          messages.push(new ToolMessage({ content: `未知工具: ${toolName}`, tool_call_id: tc.id!, name: toolName }));
        }
      } catch (e) {
        logs.push(`[Worker-${workerId}] 工具异常: ${(e as Error).message}`);
        messages.push(new ToolMessage({
          content: `工具执行失败: ${(e as Error).message}`,
          tool_call_id: tc.id!,
          name: toolName,
        }));
      }
    }

    // ======================================================================
    // 活动检测 — 以 LLM 活动信号为进度源，文件系统 diff 为辅助
    //
    // 原则（经你指正）:
    //   × 只看文件变化 → LLM 读 spec / 想架构时不写文件 → 误杀
    //   × 5 步阈值 → cnn_model.py 20+ 步才写完 → 阈值太激进
    //   √ 活动 = 工具调用 OR 文件变化
    //   √ 阈值 20 步（给复杂任务留足思考空间）
    //   √ DAG 120s 超时作为最终兜底
    // ======================================================================
    const currentSnapshot = await takeSnapshot(WORKSPACE_DIR);
    const fileChanges = countSnapshotDiff(lastSnapshot, currentSnapshot);
    // 工具调用本身即是活动信号 — LLM 在做事
    const hadToolCalls = response.tool_calls && response.tool_calls.length > 0;
    const stepHadActivity = hadToolCalls || fileChanges > 0;

    if (stepHadActivity) {
      noProgressSteps = 0;
      if (fileChanges > 0) lastSnapshot = currentSnapshot;
      if (fileChanges > 0) workerLog.debug(`快照 diff: ${fileChanges} 个文件变更`);
    } else {
      noProgressSteps++;
      if (noProgressSteps >= 20) {
        workerLog.warn(`连续 ${noProgressSteps} 步无任何活动（无工具调用 + 无文件变更），退出`);
        return {
          taskId: tid,
          result: parseWorkerOutput(JSON.stringify({
            status: "failed",
            summary: `连续${noProgressSteps}步无活动，疑似卡死`,
            created: [], deleted: [], modified: [],
            error: "无活动",
          }), desc, tid),
          logs,
          error: "无活动",
        };
      }
    }
  }

  // 正常退出 (步数用尽)
  workerLog.info(`worker 退出: reason=步数用尽 steps=${maxSteps}`);
  clearSpan();
  const failureDiagnosis = sameErrorCount >= 2 ? "同类错误反复出现"
    : "步数用尽";
  return { taskId: tid, result: parseWorkerOutput(JSON.stringify({
    status: "failed", summary: failureDiagnosis,
    diagnosis: failureDiagnosis,
    suggestion: failureDiagnosis === "步数用尽" ? "任务可能需要拆分为更小的步骤"
      : failureDiagnosis === "同类错误反复出现" ? `错误: ${lastError.slice(0,200)}。检查前置 Worker 的输出是否匹配当前任务`
      : "可能需要调整任务描述或增加步数上限",
    created: [], deleted: [], modified: [], error: "Worker 步数用尽",
  }), desc, tid), logs, error: failureDiagnosis };
  } finally {
    clearInterval(heartbeat);
  }
}
