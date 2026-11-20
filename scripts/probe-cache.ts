/**
 * DeepSeek 前缀缓存对照实验 — 同一 messages 连续调用两次, 观察第二次 hit。
 * 变体: ①纯文本 ②带 tools ③带 tools+tool_calls 回传
 */
const msgs = [
  { role: "system", content: "你是测试助手。".repeat(50) }, // ~700 token 稳定前缀
  { role: "user", content: "1+1 等于几? 只回答数字。" },
] as any;

const TOOLS = [{
  type: "function",
  function: {
    name: "calc",
    description: "计算器",
    parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] },
  },
}];

async function call(body: any) {
  const r = await fetch((process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.LLM_API_KEY },
    body: JSON.stringify({ model: process.env.LLM_MODEL ?? "deepseek-chat", max_tokens: 8, ...body }),
  });
  const j: any = await r.json();
  const u = j.usage ?? {};
  return `status=${r.status} prompt=${u.prompt_tokens} hit=${u.prompt_cache_hit_tokens ?? "-"} miss=${u.prompt_cache_miss_tokens ?? "-"} content=${(j.choices?.[0]?.message?.content ?? j.error?.message ?? "").slice(0, 20)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("── ① 纯文本 ×3 ──");
for (let i = 1; i <= 3; i++) { console.log(`#${i}`, await call({ messages: msgs })); await sleep(800); }

console.log("── ② 带 tools ×3 ──");
for (let i = 1; i <= 3; i++) { console.log(`#${i}`, await call({ messages: msgs, tools: TOOLS })); await sleep(800); }

console.log("── ③ 追加式 (ReAct 模式: 前缀相同, 尾部追加) ──");
const sys = { role: "system", content: "你是计算助手, 回答简短。".repeat(80) };
const u1 = { role: "user", content: "2+2 等于几? 只答数字" };
const a1 = { role: "assistant", content: "4" };
const u2 = { role: "user", content: "再加 3 等于几? 只答数字" };
console.log("#1 [sys,u1]      ", await call({ messages: [sys, u1] })); await sleep(900);
console.log("#2 [sys,u1,a1,u2]", await call({ messages: [sys, u1, a1, u2] })); await sleep(900);
console.log("#3 [sys,u1,a1,u2]", await call({ messages: [sys, u1, a1, u2] }));

console.log("── ④ tools + tool_calls 回传 (Worker 真实模式) ──");
const TOOL_MSGS1 = [sys, u1];
const aiTool = { role: "assistant", content: "", tool_calls: [{ id: "call_test_1", type: "function", function: { name: "calc", arguments: "{\"expr\":\"2+2\"}" } }] };
const toolRet = { role: "tool", tool_call_id: "call_test_1", content: "4" };
const TOOL_MSGS2 = [sys, u1, aiTool, toolRet];
console.log("#1 [sys,u1]tools        ", await call({ messages: TOOL_MSGS1, tools: TOOLS })); await sleep(900);
console.log("#2 +ai(tool)+tool 追加   ", await call({ messages: TOOL_MSGS2, tools: TOOLS })); await sleep(900);
console.log("#3 同#2 重复             ", await call({ messages: TOOL_MSGS2, tools: TOOLS }));
