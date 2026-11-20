/** Worker LLM 隔离探测 — 全量工具表 vs 只读工具表 */
const { createWorkLLM, createLLMClient } = await import("../src/core/llm/index.js");
const { deepCloneTools } = await import("../src/core/tools/registry.js");
const { HumanMessage } = await import("@langchain/core/messages");

const all = Object.values(deepCloneTools());
console.log("工具数:", all.length, "|", all.map((t: any) => t.name).join(","));

const model = createWorkLLM(all as any);
try {
  const r = await model.invoke([new HumanMessage("用 write_file 创建 hi.txt 内容 hello")]);
  console.log("全量工具 OK:", JSON.stringify((r as any).content).slice(0, 150));
} catch (e: any) {
  console.log("全量工具 FAIL:", String(e?.message ?? e).slice(0, 600));
  // 逐工具二分定位坏 schema
  for (const t of all as any[]) {
    const m1 = createWorkLLM([t]);
    try { await m1.invoke([new HumanMessage("hi")]); } catch (err: any) {
      console.log(`  ↳ 坏工具: ${t.name}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
}
