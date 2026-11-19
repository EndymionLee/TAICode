/**
 * probe⑧ — 与 probe⑦ 完全同前缀, 但走 LangChatOpenAI.bindTools (Worker 真实路径)
 */
const { createWorkLLM } = await import("../src/core/llm/index.js");
const { deepCloneTools } = await import("../src/core/tools/registry.js");
const { WORKER_SYSTEM_PROMPT } = await import("../src/task/prompts.js");
const { SystemMessage, HumanMessage, ToolMessage } = await import("@langchain/core/messages");

const all = Object.values(deepCloneTools());
const model = createWorkLLM(all as any); // Worker 真实创建路径

const spec = { calculator: { functions: ["add", "subtract", "multiply", "divide"], constraints: ["除零抛 ZeroDivisionError"] } };
const sharedSpec = "\n\n## 项目规格 (全 Worker 共享, 必须遵守)\n```json\n" + JSON.stringify({ spec }, null, 2) + "\n```";
const task = "任务: 创建 calculator.py 实现 add/subtract/multiply/divide (除零抛 ZeroDivisionError)";

const msgs: any[] = [new SystemMessage(WORKER_SYSTEM_PROMPT + sharedSpec), new HumanMessage(task)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let step = 1; step <= 3; step++) {
  const r = await model.invoke(msgs);
  const u = (r as any).response_metadata?.token_usage ?? {};
  console.log(`step${step}: prompt=${u.prompt_tokens} hit=${u.prompt_cache_hit_tokens ?? 0} miss=${u.prompt_cache_miss_tokens ?? 0} tools=${(r as any).tool_calls?.map((t: any) => t.name).join(",") || 0}`);
  msgs.push(r);
  for (const tc of ((r as any).tool_calls ?? [])) {
    msgs.push(new ToolMessage({ content: `{"ok": true}`, tool_call_id: tc.id, name: tc.name }));
  }
  await sleep(900);
}
