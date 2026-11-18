/**
 * DAG 纯函数测试 — 依赖归一化 / 并行组统计 / 依赖合并 / 超时预算
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDependencies, countParallelGroups, mergeDependencies } from "../src/task/dag-scheduler.js";
import { estimateWorkerBudgetMs, LLM_TIMEOUT_MS, MAX_LLM_RETRIES } from "../src/task/worker.js";

test("normalizeDependencies: number / 逗号串 / 数组 三形态", () => {
  const deps = normalizeDependencies({
    "1": 2,
    "2": "3, 4",
    "3": [4, 5],
    "bad": "x",
  });
  assert.deepEqual(deps["1"], [2]);
  assert.deepEqual(deps["2"], [3, 4]);
  assert.deepEqual(deps["3"], [4, 5]);
  assert.deepEqual(deps.NaN, []); // 非数字键 → Number()=NaN → "NaN" 键, NaN 值全滤 (原行为)
});

test("countParallelGroups: 链式 3 层 = 3 组, 全并行 = 1 组", () => {
  const tasks = [
    { id: 1, description: "a", status: "pending", result: "" },
    { id: 2, description: "b", status: "pending", result: "" },
    { id: 3, description: "c", status: "pending", result: "" },
  ] as any;
  assert.equal(countParallelGroups(tasks, { "2": [1], "3": [2] }), 3);
  assert.equal(countParallelGroups(tasks, {}), 1);
  assert.equal(countParallelGroups(tasks, { "2": [1], "3": [1] }), 2);
});

test("mergeDependencies: 自动+手动并集去重", () => {
  const merged = mergeDependencies({ "1": [2] }, { "1": [3], "2": [1] });
  assert.deepEqual(merged["1"], [2, 3]);
  assert.deepEqual(merged["2"], [1]);
});

test("超时预算: 外层 ≥ 内层 LLM 重试总预算 (修复内外打架)", () => {
  const innerBudget = LLM_TIMEOUT_MS * MAX_LLM_RETRIES;
  assert.ok(estimateWorkerBudgetMs() >= innerBudget,
    `外层 ${estimateWorkerBudgetMs()}ms 必须 ≥ 内层 ${innerBudget}ms`);
  assert.equal(estimateWorkerBudgetMs(), 360_000); // 90s×3 + 90s 工具留量
});
