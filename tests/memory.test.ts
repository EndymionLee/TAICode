/**
 * Memory 测试 — SemanticMemory (范数缓存/模型感知重建) + ProjectMemory (工程记忆)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SemanticMemory, ProjectMemory } from "../src/memory/memory-system.js";

/** 确定性假 embedding: 关键词命中 → [1,0], 未命中 → [0,1] */
const fakeEmbed = (keywords: string[]) => async (text: string): Promise<number[] | null> => {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k)) ? [1, 0] : [0, 1];
};

test("SemanticMemory: 向量检索 + 范数缓存路径正确", async () => {
  const mem = new SemanticMemory(fakeEmbed(["python"]));
  await mem.add("用户: 用 python 写爬虫");
  await mem.add("用户: 今天天气不错");
  await mem.add("用户: python 装饰器怎么用");

  const results = await mem.search("python 项目", 2);
  assert.equal(results.length, 2);
  // 两条 python 相关均得分 1.0 (query [1,0] · 条目 [1,0] / (1×1))
  assert.ok(results.every((r) => r.score > 0.99));
});

test("SemanticMemory: 查询 embedding 失败 → 关键词 fallback (存量不受影响)", async () => {
  // 入库 (以"用户:"开头) 可 embed; 查询词返回 null → 走 fallback
  const mem = new SemanticMemory(async (text: string) => (text.startsWith("用户:") ? [1, 0] : null));
  await mem.add("用户: 创建 calculator.py 文件");
  assert.equal(mem.count, 1);
  const results = await mem.search("calculator", 3);
  assert.equal(results.length, 1);
  assert.equal(results[0].score, 0.5);
});

test("SemanticMemory: 空 embedding 不入库 (防污染)", async () => {
  const mem = new SemanticMemory(async () => []);
  await mem.add("应被跳过");
  assert.equal(mem.count, 0);
});

test("SemanticMemory: 换嵌入模型 → 清空重建", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-mem-"));
  const file = path.join(dir, "semanticmemory.json");
  const prevModel = process.env.TAICODE_EMBED_MODEL;

  const mem1 = new SemanticMemory(fakeEmbed(["x"]));
  await mem1.add("用户: 存一条");
  await mem1.save(file);
  assert.ok(JSON.parse(fs.readFileSync(file, "utf-8"))._meta.model);

  process.env.TAICODE_EMBED_MODEL = "Xenova/bge-small-zh-v1.5";
  const mem2 = new SemanticMemory(fakeEmbed(["x"]));
  await mem2.load(file);
  assert.equal(mem2.count, 0, "模型切换后应清空重建");

  if (prevModel === undefined) delete process.env.TAICODE_EMBED_MODEL;
  else process.env.TAICODE_EMBED_MODEL = prevModel;
});

test("ProjectMemory: 记录技术栈/布局/结果 + 去重", () => {
  const proj = new ProjectMemory();
  const changed1 = proj.recordTaskOutcome(
    "用 python 写一个猫狗分类 CNN",
    "已完成: 创建了 train.py models/cnn.py",
    ["D:/ws/train.py", "D:/ws/models/cnn.py"],
  );
  assert.ok(changed1);
  assert.ok(proj.count >= 2); // stack + layout + outcome

  const before = proj.count;
  proj.recordTaskOutcome("用 python 写一个猫狗分类 CNN", "已完成", ["train.py"]); // 近似重复 → upsert 不增条数(或增极少)
  assert.ok(proj.count <= before + 1);
});

test("ProjectMemory: 关键词检索命中既往任务", () => {
  const proj = new ProjectMemory();
  proj.recordTaskOutcome("写一个计算器项目", "完成 calculator.py", ["calculator.py"]);
  const hits = proj.search("继续改计算器", 3);
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.text.includes("计算器")));
});

test("ProjectMemory: save/load 跨会话持久", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-projmem-"));
  const file = path.join(dir, "project-memory.json");
  const p1 = new ProjectMemory();
  p1.recordTaskOutcome("搭 react 前端", "完成", ["App.tsx", "main.tsx"]);
  await p1.save(file);

  const p2 = new ProjectMemory();
  await p2.load(file);
  assert.equal(p2.count, p1.count);
  assert.ok(p2.search("react", 5).length >= 1);
});
