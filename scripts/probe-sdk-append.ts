/**
 * probe⑥ — openai SDK 层 (LangChain 同底层): 13 工具 + 两步追加, 观察命中
 */
import OpenAI from "openai";
import { createHash } from "crypto";

const client = new OpenAI({
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL,
});

const { deepCloneTools } = await import("../src/core/tools/registry.js");
const all = Object.values(deepCloneTools()) as any[];
// 与 LangChain bindTools 相同的转换
const tools = all.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

const SYS = "你是任务执行 Worker。".repeat(60) + "\n\n## 项目规格\n```json\n{\"a\":{\"functions\":[\"x\"]}}\n```";
const msgs: any[] = [
  { role: "system", content: SYS },
  { role: "user", content: "任务: 用 write_file 创建 t.txt 内容 hi, 完成后输出 JSON 结果" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dump = (u: any) => `prompt=${u.prompt_tokens} hit=${u.prompt_cache_hit_tokens ?? 0} miss=${u.prompt_cache_miss_tokens ?? 0}`;

for (let step = 1; step <= 3; step++) {
  const r = await client.chat.completions.create({ model: process.env.LLM_MODEL ?? "deepseek-chat", messages: msgs, tools });
  console.log(`step${step}: ${dump(r.usage)} tool_calls=${r.choices[0].message.tool_calls?.length ?? 0}`);
  const m = r.choices[0].message;
  msgs.push(m as any);
  for (const tc of m.tool_calls ?? []) {
    msgs.push({ role: "tool", tool_call_id: tc.id, content: "(执行完成) ok" });
  }
  await sleep(900);
}

// 前缀字节对比
console.log("msgs[0] 一致性:", msgs[0].content === SYS ? "√" : "×");
console.log("tools hash:", createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 12), `(${tools.length} 工具)`);
