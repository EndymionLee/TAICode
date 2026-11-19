/**
 * Worker Output — 结构化输出契约测试
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerOutput } from "../src/task/worker-output.js";

test("合法 JSON: 字段补全 + task_id 注入 (缺 status 保守落 failed)", () => {
  const out = JSON.parse(parseWorkerOutput('{"summary":"创建了a.py","created":["D:/ws/a.py"]}', "任务", 3));
  assert.equal(out.task_id, 3);
  assert.equal(out.status, "failed"); // 缺 status → 保守 failed (契约)
  assert.equal(out.cwd, "D:/ws");
  assert.deepEqual(out.modified, []);
  assert.equal(out.error, null);
});

test("P2-2 契约: blocked_on/confidence 自动补全 (驼峰容错+非法值回落)", () => {
  const out = JSON.parse(parseWorkerOutput('{"summary":"ok","blockedOn":[3],"confidence":"0.9"}'));
  assert.deepEqual(out.blocked_on, [3]);
  assert.equal(out.confidence, 0.9);

  const out2 = JSON.parse(parseWorkerOutput('{"summary":"ok"}'));
  assert.equal(out2.blocked_on, null);
  assert.equal(out2.confidence, 0.5);

  const out3 = JSON.parse(parseWorkerOutput('{"summary":"ok","confidence":"高"}'));
  assert.equal(out3.confidence, 0.5); // 非法值回落
});

test("合法 JSON: 显式 status 原样保留", () => {
  const out = JSON.parse(parseWorkerOutput('{"status":"success","summary":"ok","created":[]}', "t", 1));
  assert.equal(out.status, "success");
});

test("sumary typo 容错", () => {
  const out = JSON.parse(parseWorkerOutput('{"sumary":"typo 版","created":[]}'));
  assert.equal(out.summary, "typo 版");
});

test("垃圾文本: 标准化 error JSON, 永不透传 raw text", () => {
  const out = JSON.parse(parseWorkerOutput("我完成了任务！真的！"));
  assert.equal(out.status, "failed");
  assert.equal(out.error, "输出格式错误");
  assert.ok(out.summary.includes("输出格式错误"));
});

test("summary 超 120 字硬截断", () => {
  const out = JSON.parse(parseWorkerOutput(JSON.stringify({ summary: "长".repeat(200) })));
  assert.ok(out.summary.length <= 124);
  assert.ok(out.summary.endsWith("..."));
});

test("markdown fence 包裹的 JSON 可提取", () => {
  const raw = "```json\n{\"summary\":\"fenced\"}\n```";
  const out = JSON.parse(parseWorkerOutput(raw));
  assert.equal(out.summary, "fenced");
});

test("任务描述兜底 cwd 提取 (Windows 路径)", () => {
  const out = JSON.parse(parseWorkerOutput('{"summary":"ok"}', "创建 E:\\proj\\cc\\a.py", 1));
  assert.equal(out.cwd, "E:\\proj\\cc");
});
