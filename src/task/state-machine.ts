/**
 * Runtime State Machine — 显式状态机, 从 graph.ts 抽出为可测试的强制组件
 *
 * 旧实现缺陷: transition() 非法转换只打日志不阻断, RuntimeState 与
 * LangGraph 真实路由是两套平行系统, 漂移无人拦截。
 *
 * 本模块的强制力设计:
 *   1. advanceRuntimeState() 是唯一的 runtimeState 推进入口 —
 *      返回值即节点应写入 state 的值, 保证 state 永远跟随真实控制流 (自愈, 不漂移)
 *   2. 非法转换被计数并带上下文记录, runTask 结束时可上报
 *   3. TAICODE_STRICT_STATE=1 时非法转换直接抛异常 (开发/测试用, 生产默认自愈)
 */
import { createLogger } from "../core/logger.js";

const log = createLogger("task:state");

export enum RuntimeState {
  IDLE = "idle",
  IF_PLAN = "if_plan",
  PLANNING = "planning",
  SPLITTING = "splitting",
  EXECUTING = "executing",
  VALIDATING = "validating",
  REPAIRING = "repairing",
  SUMMARIZING = "summarizing",
  FINISHED = "finished",
}

export const VALID_TRANSITIONS: Record<RuntimeState, RuntimeState[]> = {
  [RuntimeState.IDLE]:        [RuntimeState.IF_PLAN],
  [RuntimeState.IF_PLAN]:     [RuntimeState.PLANNING, RuntimeState.EXECUTING],
  [RuntimeState.PLANNING]:    [RuntimeState.SPLITTING],
  [RuntimeState.SPLITTING]:   [RuntimeState.EXECUTING],
  // 简单路径 (simple_worker) 跳过 VALIDATING 直达汇总 — 与真实控制流一致
  [RuntimeState.EXECUTING]:   [RuntimeState.VALIDATING, RuntimeState.SUMMARIZING],
  // 大任务循环: VALIDATING → SPLITTING (多轮) 或 EXECUTING (TaskSplitter 拆完直接执行)
  [RuntimeState.VALIDATING]:  [RuntimeState.SPLITTING, RuntimeState.EXECUTING, RuntimeState.SUMMARIZING, RuntimeState.REPAIRING],
  [RuntimeState.REPAIRING]:   [RuntimeState.VALIDATING, RuntimeState.SUMMARIZING],
  [RuntimeState.SUMMARIZING]: [RuntimeState.FINISHED],
  [RuntimeState.FINISHED]:    [],
};

export interface StateViolation {
  from: RuntimeState;
  to: RuntimeState;
  context: string;
  at: number;
}

/** 当前 runTask 生命周期内的违规记录 (模块级, runTask 入口 reset) */
let violations: StateViolation[] = [];

export function resetViolations(): void {
  violations = [];
}

export function getViolations(): readonly StateViolation[] {
  return violations;
}

export function isLegalTransition(from: RuntimeState, to: RuntimeState): boolean {
  if (from === to) return true; // 幂等
  const allowed = VALID_TRANSITIONS[from];
  return !!allowed && allowed.includes(to);
}

/**
 * 唯一推进入口。始终返回 `to` (自愈), 非法时记录违规;
 * TAICODE_STRICT_STATE=1 时抛异常拦截。
 */
export function advanceRuntimeState(
  from: RuntimeState | undefined,
  to: RuntimeState,
  context: string,
): RuntimeState {
  if (from === undefined || isLegalTransition(from, to)) {
    log.debug(`状态: ${from ?? "(init)"} → ${to} (${context})`);
    return to;
  }
  const violation: StateViolation = { from, to, context, at: Date.now() };
  violations.push(violation);
  log.error(`非法状态转换: ${from} → ${to} (${context}) #${violations.length}`);
  if (process.env.TAICODE_STRICT_STATE === "1") {
    throw new Error(`非法状态转换: ${from} → ${to} (${context})`);
  }
  // 生产自愈: state 跟随真实控制流, 防止 RuntimeState 与图路由漂移
  return to;
}
