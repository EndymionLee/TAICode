/**
 * probe⑦ — 完整复刻 Worker 真实前缀: 真 WORKER_SYSTEM_PROMPT+spec 块 + 12 工具 + temperature 0
 */
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL });
const { deepCloneTools } = await import("../src/core/tools/registry.js");
const { WORKER_SYSTEM_PROMPT } = await import("../src/task/prompts.js");

const all = Object.values(deepCloneTools()) as any[];
const tools = all.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));

// 与 graph.ts dagSchedulerNode 完全一致的 spec 块
const spec = { calculator: { functions: ["add", "subtract", "multiply", "divide"], constraints: ["除零抛 ZeroDivisionError"] } };
const sharedSpec = "\n\n## 项目规格 (全 Worker 共享, 必须遵守)\n```json\n" + JSON.stringify({ spec }, null, 2) + "\n```";

const system = WORKER_SYSTEM_PROMPT + sharedSpec;
const task = "任务: 创建 calculator.py 实现 add/subtract/multiply/divide (除零抛 ZeroDivisionError)";

const msgs: any[] = [{ role: "system", content: system }, { role: "user", content: task }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dump = (u: any) => `prompt=${u.prompt_tokens} hit=${u.prompt_cache_hit_tokens ?? 0} miss=${u.prompt_cache_miss_tokens ?? 0}`;

console.log(`system 长度: ${system.length} 字符, tools: ${tools.length}`);
for (let step = 1; step <= 3; step++) {
  const r = await client.chat.completions.create({ model: process.env.LLM_MODEL ?? "deepseek-chat", messages: msgs, tools, temperature: 0 });
  console.log(`step${step}: ${dump(r.usage)} tool_calls=${r.choices[0].message.tool_calls?.map((t: any) => t.function.name).join(",") || 0}`);
  const m = r.choices[0].message;
  msgs.push(m as any);
  for (const tc of m.tool_calls ?? []) {
    msgs.push({ role: "tool", tool_call_id: tc.id, content: `{"ok": true, "path": "D:/x/${tc.function.name}.out", "content": "done"}` });
  }
  await sleep(900);
}
