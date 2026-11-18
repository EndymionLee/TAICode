/**
 * State Machine — 显式状态机测试
 * 覆盖: 合法流转 / 非法检测+自愈 / strict 模式抛异常 / 真实流程全链路合法性
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeState, VALID_TRANSITIONS, advanceRuntimeState,
  resetViolations, getViolations, isLegalTransition,
} from "../src/task/state-machine.js";

beforeEach(() => resetViolations());

test("合法转换: 不产生违规", () => {
  const s1 = advanceRuntimeState(RuntimeState.IDLE, RuntimeState.IF_PLAN, "t");
  const s2 = advanceRuntimeState(s1, RuntimeState.PLANNING, "t");
  assert.equal(s2, RuntimeState.PLANNING);
  assert.equal(getViolations().length, 0);
});

test("幂等: 同状态转换合法", () => {
  assert.equal(isLegalTransition(RuntimeState.VALIDATING, RuntimeState.VALIDATING), true);
  advanceRuntimeState(RuntimeState.VALIDATING, RuntimeState.VALIDATING, "t");
  assert.equal(getViolations().length, 0);
});

test("非法转换: 记录违规 + 自愈返回目标 (state 不漂移)", () => {
  const prevEnv = process.env.TAICODE_STRICT_STATE;
  delete process.env.TAICODE_STRICT_STATE;
  const result = advanceRuntimeState(RuntimeState.IDLE, RuntimeState.FINISHED, "跳变");
  assert.equal(result, RuntimeState.FINISHED); // 自愈: 跟随真实控制流
  assert.equal(getViolations().length, 1);
  assert.equal(getViolations()[0].from, RuntimeState.IDLE);
  assert.equal(getViolations()[0].to, RuntimeState.FINISHED);
  if (prevEnv !== undefined) process.env.TAICODE_STRICT_STATE = prevEnv;
});

test("strict 模式: 非法转换抛异常 (开发/测试用)", () => {
  process.env.TAICODE_STRICT_STATE = "1";
  assert.throws(() => advanceRuntimeState(RuntimeState.FINISHED, RuntimeState.PLANNING, "t"));
  delete process.env.TAICODE_STRICT_STATE;
});

test("真实流程全链路: 复杂任务 (plan→split→dag→validate→循环→汇总) 无违规", () => {
  let s: RuntimeState = RuntimeState.IDLE;
  s = advanceRuntimeState(s, RuntimeState.IF_PLAN, "入口");
  s = advanceRuntimeState(s, RuntimeState.PLANNING, "if_plan");
  s = advanceRuntimeState(s, RuntimeState.SPLITTING, "planner");
  s = advanceRuntimeState(s, RuntimeState.EXECUTING, "taskSplitter");
  s = advanceRuntimeState(s, RuntimeState.VALIDATING, "dagScheduler");
  // 大任务循环: validate → 再拆 → 再执行
  s = advanceRuntimeState(s, RuntimeState.SPLITTING, "validator→更多");
  s = advanceRuntimeState(s, RuntimeState.EXECUTING, "taskSplitter");
  s = advanceRuntimeState(s, RuntimeState.VALIDATING, "dagScheduler");
  s = advanceRuntimeState(s, RuntimeState.SUMMARIZING, "validator→汇总");
  s = advanceRuntimeState(s, RuntimeState.FINISHED, "汇总完成");
  assert.equal(s, RuntimeState.FINISHED);
  assert.equal(getViolations().length, 0);
});

test("真实流程全链路: 简单任务 (exec→summarize 跳过 validate) 无违规 — 状态表已纠偏", () => {
  let s: RuntimeState = RuntimeState.IDLE;
  s = advanceRuntimeState(s, RuntimeState.IF_PLAN, "入口");
  s = advanceRuntimeState(s, RuntimeState.EXECUTING, "if_plan→simple");
  s = advanceRuntimeState(s, RuntimeState.SUMMARIZING, "simpleWorker");
  s = advanceRuntimeState(s, RuntimeState.FINISHED, "直出");
  assert.equal(getViolations().length, 0); // 旧表此处会静默记 error
});

test("转换表完整性: 每个状态的出口都在表内", () => {
  const allStates = Object.values(RuntimeState);
  for (const from of allStates) {
    const targets = VALID_TRANSITIONS[from];
    assert.ok(Array.isArray(targets), `${from} 缺转换表`);
    for (const to of targets) assert.ok(allStates.includes(to), `${from}→${to} 目标不存在`);
  }
});
