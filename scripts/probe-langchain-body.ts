/**
 * probe⑤ — 复刻 Worker 调用路径, 抓 LangChain 实际请求体, 验证两步前缀是否字节一致
 */
const { createWorkLLM } = await import("../src/core/llm/index.js");
const { deepCloneTools } = await import("../src/core/tools/registry.js");
const { SystemMessage, HumanMessage, ToolMessage } = await import("@langchain/core/messages");

// 包装 fetch: 记录请求体长度 + 前 300 字符 + 全文 hash
let lastBodies: string[] = [];
const origFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init?: any) => {
  if (init?.body && String(url).includes("chat/completions")) {
    lastBodies.push(String(init.body));
  }
  return origFetch(url, init);
};
const { createHash } = await import("crypto");
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const all = Object.values(deepCloneTools());
const model = createWorkLLM(all as any);
const sys = new SystemMessage("你是任务执行 Worker。".repeat(60) + "\n\n## 项目规格\n```json\n{\"a\":{\"functions\":[\"x\"]}}\n```");
const task = new HumanMessage("任务: 用 write_file 创建 t.txt 内容 hi, 然后输出 JSON");

const msgs: any[] = [sys, task];
for (let step = 1; step <= 2; step++) {
  const r = await model.invoke(msgs);
  const body = lastBodies[lastBodies.length - 1];
  console.log(`step${step}: body=${body.length}B hash=${h(body)} usage_hit=${(r as any).response_metadata?.token_usage?.prompt_cache_hit_tokens ?? "-"} miss=${(r as any).response_metadata?.token_usage?.prompt_cache_miss_tokens ?? "-"}`);
  // 手动构造干净的追加消息 (与 worker 相同: push 原始 AIMessage + ToolMessage)
  msgs.push(r);
  if (r.tool_calls?.length) {
    for (const tc of r.tool_calls) msgs.push(new ToolMessage({ content: "ok-done", tool_call_id: tc.id!, name: tc.name }));
  }
}
// 对比两步请求体: 找共同前缀长度
if (lastBodies.length >= 2) {
  const [a, b] = lastBodies;
  let i = 0; const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  console.log(`共同前缀: ${i}B / a=${a.length}B b=${b.length}B`);
  console.log("a 头 300:", a.slice(0, 300).replace(/\s+/g, " "));
  console.log("b 分歧前 120:", a.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, " "));
}
