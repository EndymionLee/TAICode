/**
 * MCP stdio Transport
 *
 * 通过子进程 stdin/stdout 与 MCP server 通信。
 * 协议: JSON-RPC 2.0, 每行一个 JSON 消息, 以 \n 分隔。
 */
import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import type { JSONRPCRequest, JSONRPCResponse } from "../types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("mcp:stdio");

interface StdioConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class StdioClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: JSONRPCResponse) => void; reject: (e: Error) => void }>();
  private rl: ReturnType<typeof createInterface> | null = null;

  constructor(private config: StdioConfig) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.config.command, this.config.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.config.env },
        cwd: this.config.cwd ?? process.cwd(),
      });

      // 启动超时 15s (Python 冷启动可能较慢)
      const startTimer = setTimeout(() => {
        reject(new Error(`启动超时(15s): ${this.config.command} ${this.config.args.join(" ")}`));
      }, 15_000);

      this.process.on("error", (e) => {
        clearTimeout(startTimer);
        reject(new Error(`spawn 失败: ${e.message}`));
      });
      this.process.on("exit", (code) => {
        clearTimeout(startTimer);
        if (code !== 0 && code !== null) {
          const stderr = stderrBuf.trim();
          log.warn(`${this.config.name} 退出 code=${code}${stderr ? ` stderr: ${stderr.slice(0, 200)}` : ""}`);
        }
        this.cleanupPending(new Error(`进程已退出 (code=${code})`));
      });

      const stdout = this.process.stdout;
      if (!stdout) { reject(new Error("spawn 失败: 无 stdout")); return; }
      this.rl = createInterface({ input: stdout, crlfDelay: Infinity });
      this.rl.on("line", (line: string) => {
        try {
          const msg = JSON.parse(line) as JSONRPCResponse;
          const pending = this.pending.get(msg.id);
          if (pending) { this.pending.delete(msg.id); pending.resolve(msg); }
        } catch { /* ignore non-JSON lines */ }
      });

      let stderrBuf = "";
      if (this.process.stderr) {
        this.process.stderr.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
      }

      // 等 500ms 让进程启动，然后通过 initialize 调用验证连通性
      setTimeout(() => { clearTimeout(startTimer); resolve(); }, 500);
    });
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const p = this.process;
    if (!p || !p.stdin) throw new Error("未连接");

    const id = this.nextId++;
    const req: JSONRPCRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (r) => {
        if (r.error) reject(new Error(`MCP error: ${r.error.message}`));
        else resolve(r.result);
      }, reject });

      p.stdin!.write(JSON.stringify(req) + "\n");
    });
  }

  async stop(): Promise<void> {
    this.cleanupPending(new Error("transport 已关闭"));
    if (this.rl) { this.rl.close(); this.rl = null; }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  private cleanupPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
