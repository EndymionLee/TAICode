/**
 * MCP SSE Transport — FastMCP 202 响应 + SSE 流
 */
import { createLogger } from "../../logger.js";

const log = createLogger("mcp:sse");

export interface SSEServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export class SSEClient {
  private baseUrl: string;
  private messageUrl = "";
  private headers: Record<string, string>;
  private nextId = 1;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

  constructor(private config: SSEServerConfig) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.headers = config.headers ?? {};
  }

  async start(): Promise<void> {
    const sseUrl = `${this.baseUrl}/sse`;
    const resp = await fetch(sseUrl, {
      headers: { "Accept": "text/event-stream", ...this.headers },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`SSE 握手失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    this.reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // 持续读 SSE 流：解析 endpoint + JSON-RPC 响应
    (async () => {
      while (this.reader) {
        let done = false, value: Uint8Array | undefined;
        try {
          ({ done, value } = await this.reader.read());
        } catch { break; }
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 解析 endpoint
        if (!this.messageUrl) {
          const m = buffer.match(/event:\s*endpoint\s*\ndata:\s*(\S+)/);
          if (m) {
            const path = m[1].trim();
            this.messageUrl = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
            log.info(`${this.config.name}: 已连接`);
          }
        }

        // 解析 JSON-RPC 响应: 从 "data:" 后提取完整 JSON (括号计数)
        let idx = buffer.indexOf("data:");
        while (idx !== -1) {
          const start = buffer.indexOf("{", idx);
          if (start === -1) break;
          let depth = 0, end = start;
          for (let j = start; j < buffer.length; j++) {
            if (buffer[j] === "{") depth++;
            else if (buffer[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
          }
          if (depth !== 0) break; // JSON 不完整，等下一次 chunk
          try {
            const jsonStr = buffer.slice(start, end);
            const msg = JSON.parse(jsonStr);
            if (msg.id !== undefined) {
              const pending = this.pending.get(msg.id);
              if (pending) {
                this.pending.delete(msg.id);
                if (msg.error) pending.reject(new Error(msg.error.message));
                else pending.resolve(msg.result);
              }
            }
            buffer = buffer.slice(0, idx) + buffer.slice(end); // 移除已处理的 data 行
          } catch { idx = end; }
          idx = buffer.indexOf("data:", idx);
        }
        // 清理 buffer
        if (buffer.length > 10_000) buffer = buffer.slice(-5000);
      }
    })().catch(() => {});
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.messageUrl) {
      for (let i = 0; i < 50 && !this.messageUrl; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!this.messageUrl) throw new Error("SSE 未连接");
    }

    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    // 先注册 pending，再发请求（防 SSE 响应竞态）
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error("SSE 响应超时(30s)"));
      }, 30_000);
    });

    const resp = await fetch(this.messageUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body,
    });

    if (resp.status === 202) return promise;

    // 直接 JSON 响应: 清理 pending + 解析
    this.pending.delete(id);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const json = await resp.json() as any;
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  async stop(): Promise<void> {
    if (this.reader) { try { this.reader.cancel(); } catch { /* ignore */ } this.reader = null; }
    this.pending.clear();
    this.messageUrl = "";
  }
}
