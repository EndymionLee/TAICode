/**
 * Pure Runtime Session — 不知道终端存在
 *
 * 职责: 初始化 + ask() → 编译上下文 → Chat/Task → emit 事件
 * 不负责: Input / Renderer / console.log
 */
import * as path from "path";
import * as fs from "fs";
import { createLLMClient, sanitizeFunctionName } from "../core/llm.js";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { MemorySystem } from "../memory/memory-system.js";
import { safeJsonParse } from "../core/json-utils.js";
import { runTask } from "../task/graph.js";
import { initSkillIndex, syncSkillIndex } from "../core/skill-index.js";
import { toolsList, loadMCPTools, stopMCP } from "../core/tools/registry.js";
import { events } from "../core/events.js";
import { TASK_GATE_PROMPT } from "../task/prompts.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("runtime");
const CWD = process.env.TAICODE_CWD ?? process.cwd();
const DATA_DIR = path.resolve(CWD, ".TAI");
const SESSIONS_DIR = path.resolve(DATA_DIR, "sessions");
const AUTO_SAVE_INTERVAL = 3;

function makeSessionDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(SESSIONS_DIR, ts);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const CHAT_SYSTEM_PROMPT = `你是 TAICode，一个 AI 编程助手。

## 身份边界（必须严格遵守）
上下文中 [USER PROFILE] 区块描述的是**用户**，不是你自己。
- 用户姓名 ≠ 你的名字。你不叫那个名字。
- 用户兴趣 ≠ 你的兴趣。不要对用户的兴趣表示"我也喜欢"。
- 你是 AI，没有身体、家庭、童年经历。

## 回答风格
简洁、自然、有帮助。如果用户是闲聊、吐槽、反问，保持简短（1-3句），不要扩写成文章。
调用工具后如实汇报结果，禁止编造、推测或添加工具未返回的数据。`;


/** 反问/吐槽/否定/确认 → 1-3句话, 不写作文不写代码 */
function isMetaQuestion(input: string): boolean {
  const t = input.trim();
  if (/^(可以|好|行|嗯|哦|ok|yes|对|是|知道了|明白|懂|收到|了解|没错)$/i.test(t)) return true;
  if (t.length <= 3 && /^[a-zA-Z0-9!！。.,，?？]+$/.test(t)) return true; // 短数字/符号/字母
  if (t.length <= 1) return true;
  return /为什么|你怎么|别写|不要|？\s*$|\?\s*$|吗[？?]?\s*$/.test(input);
}

/** 明确要求写长文 (以"写"开头且超过10字) */
function isArticleRequest(input: string): boolean {
  return /^写/.test(input) && input.length > 10;
}

export class Session {
  private chatLLM = createLLMClient({ temperature: 0.7 });
  private summaryLLM = createLLMClient({ temperature: 0 });
  private memory!: MemorySystem;
  private turnCount = 0;
  private initialized = false;
  private _lastWasTask = false;

  get modelName(): string { return this.chatLLM.modelName; }

  async init(): Promise<void> {
    if (this.initialized) return;
    log.info("══════════════ TAICode 启动 ══════════════");
    log.info(`模型: ${this.chatLLM.modelName} · CWD: ${process.cwd()}`);
    const embedFn = async (text: string): Promise<number[] | null> => {
      try { const r = await this.summaryLLM.embed(text); return r?.[0]?.length > 0 ? r[0] : null; }
      catch { return null; }
    };
    initSkillIndex(embedFn);
    await syncSkillIndex();
    const sessionDir = makeSessionDir();
    log.info(`会话目录: ${sessionDir}`);
    this.memory = new MemorySystem({ llm: this.summaryLLM, personaLLM: this.summaryLLM, importantLLM: this.summaryLLM, embedFn, dataDir: sessionDir });
    await this.memory.initialize();
    events.memory.loaded(this.memory.shortTerm.count, this.memory.semantic.count, this.memory.persona.name ?? "-");
    // MCP 后台异步加载，不阻塞启动
    loadMCPTools().then((mcpTools) => {
      if (mcpTools.length > 0) log.info(`MCP: 注册 ${mcpTools.length} 个工具 (后台完成)`);
    });
    events.session.start(this.chatLLM.modelName);
    this.initialized = true;
    log.info("══════════════ 启动完成，等待输入 ══════════════");
  }

  /** 处理用户输入, 返回 AI 回复。仅 emit 事件, 不接触终端。 */
  async ask(userInput: string): Promise<string> {
    events.chat.user(userInput);  // 必须在 LLM 调用之前, 确保 UI 先显示用户消息
    const context = await this.memory.compileContext(userInput);
    log.info(`对话 #${this.turnCount + 1}: lastWasTask=${this._lastWasTask}`);

    let response = "";

    // LLM 一次性三分类：chat / simple_task / complex_task
    const gateResult = await this.chatLLM.chat(
      [{ role: "user", content: TASK_GATE_PROMPT.replace("{userInput}", userInput).replace("{history}", context) } as any],
      { temperature: 0 }
    );
    let intent = "chat";
    try { intent = JSON.parse(gateResult.trim()).intent || "chat"; } catch { /* 解析失败默认 chat */ }
    log.info(`[Gate] intent=${intent}`);

    if (intent === "chat") {
      this._lastWasTask = false;
    } else {
      const startTime = Date.now();
      const shortCtx = this.memory.shortTerm.toText(5);
      response = await runTask(userInput, shortCtx);
      events.chat.assistant(response);
      events.task.result(response, Date.now() - startTime);
      this._lastWasTask = true;
      this.turnCount++;
      return response;
    }
    {
      // 上一轮是任务 → 告诉 LLM 已完成
      const taskDoneNote = this._lastWasTask ? "\n 上一轮任务已经执行完成，用户现在在进行后续对话，不要重复执行。" : "";
      const style = isArticleRequest(userInput) ? "" : isMetaQuestion(userInput) ? "\ 用户的消息很短，请用1-3句话回答，禁止输出代码！" : "";
      const contextBlock = context ? `\n\n${context}` : "";

      // Chat 模式: 带 capability=read 工具的 function calling 循环
      // 但短确认/反问 不上工具，直接纯文本避免 bindTools 返回空
      const readTools: typeof toolsList = []; // 聊天不绑工具，bindTools 会阻止 DeepSeek 流式
      const fnNameMap = new Map(readTools.map((t) => [sanitizeFunctionName(t.name, this.chatLLM.modelName), t]));
      const toolHint = readTools.length > 0
        ? "\n\n你有以下工具可以调用: " + readTools.map(t => `${t.name}(${t.description})`).join(", ")
        + "\n调用工具后，必须如实汇报结果，禁止编造、推测或添加任何工具未返回的数据。"
        : "";
      const systemPrompt = CHAT_SYSTEM_PROMPT + taskDoneNote + style + toolHint + contextBlock;
      const chatMessages: any[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userInput },
      ];

      response = "";
      const msgId = events.llm.start();

      // bindTools 是 LangChain 的标准做法
      // DeepSeek 要求函数名匹配 ^[a-zA-Z0-9_-]+$，/ 不合法，替换为 _
      let modelWithTools: any = null;
      if (readTools.length > 0) {
        const toolDefs = readTools.map((t) => ({
          type: "function" as const,
          function: { name: sanitizeFunctionName(t.name, this.chatLLM.modelName), description: t.description, parameters: t.parameters as any },
        }));
        modelWithTools = this.chatLLM.model.bindTools(toolDefs);
      }

      for (let loop = 0; loop < 3; loop++) {
        if (!modelWithTools) {
          try {
            const stream = this.chatLLM.stream(
              chatMessages.map(m => ({ role: m.role, content: m.content })),
              { temperature: 0.7 }
            );
            response = "";
            for await (const token of stream) {
              response += token;
              events.llm.token(msgId, token);
            }
            if (!response) response = "(没有收到回复)";
          } catch (e) {
            response = `(回复失败: ${(e as Error).message})`;
          }
          break;
        }
        try {
          // 流式调用 — 逐 token 推送 + 收集 tool_calls
          const stream = await modelWithTools.stream(chatMessages);
          let content = "";
          const toolCallAcc: Map<number, { name: string; args: string }> = new Map();
          for await (const chunk of stream) {
            const text = typeof chunk?.content === "string" ? chunk.content : "";
            if (text) { content += text; events.llm.token(msgId, text); }
            // 收集 tool_call 分片
            for (const tc of (chunk?.tool_call_chunks ?? [])) {
              if (!toolCallAcc.has(tc.index!)) toolCallAcc.set(tc.index!, { name: tc.name ?? "", args: "" });
              const acc = toolCallAcc.get(tc.index!)!;
              if (tc.name) acc.name = tc.name;
              if (tc.args) acc.args += tc.args;
            }
          }

          const toolCalls = [...toolCallAcc.entries()].map(([idx, acc]) => ({
            id: `call_${idx}`, name: acc.name, args: safeJsonParse(acc.args) as Record<string, unknown> || {},
          }));

          if (toolCalls.length === 0) {
            if (!content) throw new Error("模型返回空内容");
            response = content;
            break;
          }

          // 构造 AI 消息并执行工具
          chatMessages.push(new AIMessage({ content, tool_calls: toolCalls as any }));
          for (const tc of toolCalls) {
            const t = fnNameMap.get(tc.name);
            if (!t) continue;
            try {
              const result = await t.execute(tc.args ?? {});
              chatMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
            } catch (e) {
              chatMessages.push({ role: "tool", tool_call_id: tc.id, content: `错误: ${(e as Error).message}` });
            }
          }
        } catch (e) {
          log.warn(`chat: 调用失败: ${(e as Error).message}`);
          try {
            const fb = await this.chatLLM.chat(
              [new SystemMessage(systemPrompt), new HumanMessage(userInput)],
              { temperature: 0.7 });
            response = fb || "(模型返回空)";
          } catch {
            response = "(回复生成失败)";
          }
          events.llm.token(msgId, response);
          break;
        }
      }
      events.llm.done(msgId, response || "(未收到回复)");
    }

    await this.memory.process(userInput, response);
    this.turnCount++;
    if (this.turnCount % AUTO_SAVE_INTERVAL === 0) await this.save();
    return response;
  }

  async save(): Promise<void> {
    await this.memory.saveAll();
    events.memory.saved(this.memory.shortTerm.count, this.memory.semantic.count, this.memory.persona.name ?? "-");
  }

  async close(): Promise<void> {
    await this.save();
    await stopMCP();
    log.info("══════════════ TAICode 关闭 ══════════════");
  }
}
