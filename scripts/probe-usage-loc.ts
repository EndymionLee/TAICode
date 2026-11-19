/**
 * probe⑨ — ①LangChain AIMessage 上 usage 的真实位置/键名
 *          ②fetch tap 在 client 构造前安装能否捕获响应
 */
// ── ②先装 tap, 再 import LangChain (验证捕获时机) ──
let tapped: any[] = [];
const origFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init?: any) => {
  const res = await origFetch(url, init);
  if (String(url).includes("chat/completions")) {
    try { const c = res.clone(); const j = await c.json(); if (j.usage) tapped.push({ url: String(url), usage: j.usage }); } catch { /* ignore */ }
  }
  return res;
};

const { createLLMAdapter } = await import("../src/core/llm/index.js");
const { SystemMessage, HumanMessage } = await import("@langchain/core/messages");

const a = createLLMAdapter();
const r = await a.model.invoke([
  new SystemMessage("你是测试助手, 回答简短。".repeat(30)),
  new HumanMessage("1+1? 只答数字"),
]);

console.log("── ① AIMessage 上的 usage 位置 ──");
console.log("response_metadata keys:", Object.keys((r as any).response_metadata ?? {}));
console.log("response_metadata.token_usage:", JSON.stringify((r as any).response_metadata?.token_usage));
console.log("usage_metadata:", JSON.stringify((r as any).usage_metadata));
console.log("additional_kwargs keys:", Object.keys((r as any).additional_kwargs ?? {}));

console.log("── ② fetch tap 捕获 ──");
console.log("tapped:", JSON.stringify(tapped, null, 1));
