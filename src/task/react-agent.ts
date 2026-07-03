/**
 * 轻量 ReAct Agent — Planner/TaskSplitter 专用
 *
 * 与 Worker 的区别:
 *   - 只有 read 工具 (ls/read_file/grep/find/stat)
 *   - 不写文件、不调 shell
 *   - 工具结果私有，不共享
 *   - 简化版循环，无四层检测
 */
import { HumanMessage, SystemMessage, AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { createLLMClient } from "../core/llm.js";
import { toolsList } from "../core/tools/registry.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("react-agent");

const READ_TOOLS = toolsList.filter((t) => t.capability === "read" && t.name !== "shell");

/** 执行 ReAct 循环，返回 LLM 最终文本输出 */
export async function reactAgent(
  systemPrompt: string,
  userPrompt: string,
  maxSteps: number = 10,
): Promise<string> {
  const llm = createLLMClient({ temperature: 0 });
  const model = llm.model.bindTools(READ_TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  })));

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ];

  for (let step = 0; step < maxSteps; step++) {
    const result = await model.invoke(messages) as AIMessage;
    messages.push(result);

    if (!result.tool_calls || result.tool_calls.length === 0) {
      // 无工具调用 → 返回最终文本
      return typeof result.content === "string" ? result.content : "";
    }

    for (const tc of result.tool_calls) {
      const tool = READ_TOOLS.find((t) => t.name === tc.name);
      if (!tool) {
        messages.push(new ToolMessage({ content: `未知工具: ${tc.name}`, tool_call_id: tc.id!, name: tc.name }));
        continue;
      }
      try {
        const output = await tool.execute((tc.args ?? {}) as Record<string, unknown>);
        messages.push(new ToolMessage({ content: output, tool_call_id: tc.id!, name: tc.name }));
      } catch (e) {
        messages.push(new ToolMessage({ content: `执行失败: ${(e as Error).message}`, tool_call_id: tc.id!, name: tc.name }));
      }
    }
  }

  // 步数用尽 → 返回最后一条 AI 消息
  const lastAi = [...messages].reverse().find((m) => m instanceof AIMessage);
  return typeof lastAi?.content === "string" ? lastAi.content : "";
}
