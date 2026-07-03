export { createLLMAdapter, createWorkLLM, sanitizeFnName as sanitizeFunctionName } from "./llm/adapter.js";
export type { LLMAdapter } from "./llm/adapter.js";
export type { LLMAdapter as LLMClient } from "./llm/adapter.js";
// createLLMClient 别名
import { createLLMAdapter } from "./llm/adapter.js";
export const createLLMClient = createLLMAdapter;
