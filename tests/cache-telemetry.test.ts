/**
 * Cache Telemetry — 记录/命中率/报告计算/usage 提取
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordCacheUsage, recordAIMessage, extractCacheUsage,
  getCacheReport, resetCacheTelemetry,
} from "../src/core/llm/cache-telemetry.js";

beforeEach(() => resetCacheTelemetry());

test("extractCacheUsage: LangChain 标准化 usage_metadata (cache_read = 命中)", () => {
  const u = extractCacheUsage({
    usage_metadata: { input_tokens: 2452, output_tokens: 100, input_token_details: { cache_read: 2304 } },
  });
  assert.deepEqual(u, { hit: 2304, miss: 148, output: 100 });
});

test("extractCacheUsage: response_metadata.tokenUsage (camelCase, probe⑨ 实测键名)", () => {
  const u = extractCacheUsage({
    response_metadata: { tokenUsage: { prompt_tokens: 960, completion_tokens: 30, prompt_cache_hit_tokens: 768 } },
  });
  assert.deepEqual(u, { hit: 768, miss: 192, output: 30 });
});

test("extractCacheUsage: DeepSeek 风格 usage (hit/miss 字段)", () => {
  const u = extractCacheUsage({
    response_metadata: { token_usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 } },
  });
  assert.deepEqual(u, { hit: 800, miss: 200, output: 50 });
});

test("extractCacheUsage: 标准 usage_metadata (无缓存字段 → miss=prompt)", () => {
  const u = extractCacheUsage({ usage_metadata: { input_tokens: 300, output_tokens: 10 } });
  assert.deepEqual(u, { hit: 0, miss: 300, output: 10 });
});

test("extractCacheUsage: 无 usage → null", () => {
  assert.equal(extractCacheUsage({ content: "hi" }), null);
  assert.equal(extractCacheUsage(null), null);
});

test("报告计算: 命中率与累计", () => {
  recordCacheUsage({ hit: 800, miss: 200, output: 50 });
  recordCacheUsage({ hit: 600, miss: 0, output: 20 });
  recordCacheUsage(null); // 无 usage 调用只计次数
  const r = getCacheReport();
  assert.equal(r.calls, 3);
  assert.equal(r.hitTokens, 1400);
  assert.equal(r.missTokens, 200);
  assert.equal(r.totalInputTokens, 1600);
  assert.equal(r.outputTokens, 70);
  assert.ok(Math.abs(r.hitRate! - 1400 / 1600) < 1e-9);
});

test("空报告: 命中率 null 不除零", () => {
  const r = getCacheReport();
  assert.equal(r.hitRate, null);
  assert.equal(r.calls, 0);
});

test("recordAIMessage 便捷入口", () => {
  recordAIMessage({
    response_metadata: { token_usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 64 } },
  }, "test");
  const r = getCacheReport();
  assert.equal(r.calls, 1);
  assert.equal(r.hitTokens, 64);
  assert.equal(r.missTokens, 36); // prompt-hit 回退
});
