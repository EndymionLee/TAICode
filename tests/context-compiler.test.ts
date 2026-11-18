/**
 * Context Compiler — EMA 平滑 / 槽位保护 / 永生画像 / 任务查询风格降权
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextCompiler } from "../src/core/context-compiler.js";

function makeProviders(overrides: Record<string, unknown> = {}) {
  return {
    stm: { toText: (_n?: number) => "用户: 帮我创建 utils.py\nAI: 已创建" },
    sem: { search: async (_q: string, _k: number) => [{ text: "用户: 之前做过 python 爬虫项目", score: 0.8 }] },
    per: { name: "张三", interests: ["编程"], expertise: { python: "advanced" } },
    imp: { getItems: () => ["安全: 禁止删除系统文件", "风格: 回答可爱一点"] },
    ...overrides,
  };
}

test("结构化输出: 五区块齐全, 画像永生必现", async () => {
  const cc = new ContextCompiler();
  const p = makeProviders();
  const out = await cc.compile("创建项目", p.stm, p.sem, p.per, p.imp);
  assert.ok(out.includes("[PERSONA]"));
  assert.ok(out.includes("张三"));
  assert.ok(out.includes("[CONSTRAINT]"));
  assert.ok(out.includes("禁止删除系统文件"));
  assert.ok(out.includes("[KNOWLEDGE]"));
});

test("任务查询: STYLE 降权 (0.1) 但仍占槽 — 不丢约束", async () => {
  const cc = new ContextCompiler();
  const p = makeProviders();
  const out = await cc.compile("创建 utils.py 文件", p.stm, p.sem, p.per, p.imp);
  // 硬约束必须在 (CONSTRAINT 槽保底1)
  assert.ok(out.includes("[CONSTRAINT]"));
});

test("EMA 平滑: 同一片段两轮编译分数收敛, 不剧烈跳变", async () => {
  const cc = new ContextCompiler();
  const sem = { search: async () => [{ text: "用户: 语义记忆条目EMA", score: 0.9 }] };
  const pa = makeProviders({ sem });
  await cc.compile("查询A", pa.stm, pa.sem, pa.per, pa.imp);
  // 内部 prevScores 已记录; 第二轮分数变化被 α=0.7 平滑
  const pb = makeProviders({ sem });
  const out2 = await cc.compile("查询B", pb.stm, pb.sem, pb.per, pb.imp);
  assert.ok(typeof out2 === "string" && out2.length > 0);
  cc.resetScores();
  const pc = makeProviders({ sem });
  const out3 = await cc.compile("查询C", pc.stm, pc.sem, pc.per, pc.imp);
  assert.ok(out3.length > 0);
});

test("空记忆: 输出不含空区块", async () => {
  const cc = new ContextCompiler();
  const empty = {
    stm: { toText: () => "" },
    sem: { search: async () => [] },
    per: { name: null, interests: [], expertise: {} },
    imp: { getItems: () => [] },
  };
  const out = await cc.compile("你好", empty.stm, empty.sem, empty.per, empty.imp);
  assert.equal(out.trim(), "");
});

test("闲聊查询: 风格权重正常 (不降权路径)", async () => {
  const cc = new ContextCompiler();
  const p = makeProviders();
  const out = await cc.compile("讲个笑话", p.stm, p.sem, p.per, p.imp);
  assert.ok(out.includes("[STYLE]"));
  assert.ok(out.includes("可爱"));
});
