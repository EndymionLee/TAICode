/**
 * OpenAI 兼容适配器 — 所有兼容 OpenAI API 的厂商共用
 */
import * as fs from "fs";
import * as path from "path";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ToolDefinition } from "../types.js";
import { embedMany } from "./embed.js";

export interface LLMAdapter {
  readonly modelName: string;
  readonly model: ChatOpenAI;
  stream(messages: { role: string; content: string }[], options?: { temperature?: number }): AsyncGenerator<string>;
  chat(messages: BaseMessage[], options?: { temperature?: number }): Promise<string>;
  chatWithTools(messages: BaseMessage[], tools: ToolDefinition[], options?: { temperature?: number }): Promise<AIMessage>;
  bindTools(tools: ToolDefinition[]): any;
  embed(input: string | string[]): Promise<number[][]>;
}

function toOpenAITool(tool: ToolDefinition) {
  return { type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

/** 归一化函数名：[^a-zA-Z0-9_-] → _，适配 DeepSeek 等限制 */
export function sanitizeFnName(name: string, baseURL: string): string {
  if (!baseURL.includes("deepseek")) return name;
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

/** .env 加载 */
export function loadEnv(): void {
  try {
    const p = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch { /* ignore */ }
}

export class OpenAICompatAdapter implements LLMAdapter {
  readonly modelName: string;
  readonly model: ChatOpenAI;
  private baseURL: string;

  constructor(cfg: { apiKey: string; baseURL: string; model: string }) {
    this.modelName = cfg.model;
    this.baseURL = cfg.baseURL;
    this.model = new ChatOpenAI({
      apiKey: cfg.apiKey,
      configuration: { baseURL: cfg.baseURL, timeout: 90_000 },
      model: cfg.model,
      temperature: 0,
      timeout: 90_000,
    });
  }

  async *stream(messages: { role: string; content: string }[], options?: { temperature?: number }) {
    if (options?.temperature !== undefined) this.model.temperature = options.temperature;
    const s = await this.model.stream(messages);
    for await (const chunk of s) { const t = typeof chunk.content === "string" ? chunk.content : ""; if (t) yield t; }
  }

  async chat(messages: BaseMessage[], options?: { temperature?: number }): Promise<string> {
    if (options?.temperature !== undefined) this.model.temperature = options.temperature;
    const r = await this.model.invoke(messages);
    return typeof r.content === "string" ? r.content : "";
  }

  async chatWithTools(messages: BaseMessage[], tools: ToolDefinition[], options?: { temperature?: number }): Promise<AIMessage> {
    const fix = this.baseURL.includes("deepseek") ? (n: string) => sanitizeFnName(n, this.baseURL) : (n: string) => n;
    const defs = tools.map((t) => { const f = toOpenAITool(t); f.function.name = fix(t.name); return f; });
    if (options?.temperature !== undefined) this.model.temperature = options.temperature;
    const r = await this.model.bindTools(defs).invoke(messages);
    if (r instanceof AIMessage) return r;
    return new AIMessage({ content: typeof r.content === "string" ? r.content : "", tool_calls: (r as any).tool_calls });
  }

  bindTools(tools: ToolDefinition[]) {
    const fix = this.baseURL.includes("deepseek") ? (n: string) => sanitizeFnName(n, this.baseURL) : (n: string) => n;
    return this.model.bindTools(tools.map((t) => { const f = toOpenAITool(t); f.function.name = fix(t.name); return f; }));
  }

  async embed(input: string | string[]): Promise<number[][]> {
    return embedMany(input, this.model);
  }
}

/** 工厂：按 baseURL/apiKey/model 创建 */
export function createLLMAdapter(cfg?: { baseURL?: string; apiKey?: string; model?: string; temperature?: number } | string): LLMAdapter {
  loadEnv();
  const c = typeof cfg === "string" ? { model: cfg } : (cfg ?? {});
  const baseURL = c.baseURL ?? process.env.LLM_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
  const apiKey = c.apiKey ?? process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  const model = c.model ?? process.env.LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  const a = new OpenAICompatAdapter({ baseURL, apiKey, model });
  if (c.temperature !== undefined) a.model.temperature = c.temperature;
  return a;
}

export function createWorkLLM(tools: any[], modelName?: string) {
  return createLLMAdapter({ model: modelName }).bindTools(tools);
}
