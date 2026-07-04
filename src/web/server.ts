/**
 * Web 模式 — Fastify + WebSocket + 静态文件
 */
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "path";
import { fileURLToPath } from "url";
import { addClient, initRelay } from "./relay.js";
import { Session } from "../runtime/session.js";
import { readdir, readFile, writeFile } from "fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startWeb(session: Session) {
  const app = Fastify();
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "public"),
    prefix: "/",
  });

  // 初始化 EventBus → WebSocket 桥接
  initRelay();

  // WebSocket 端点
  await app.register(async function (fastify) {
    fastify.get("/ws", { websocket: true }, (socket, req) => {
      addClient(socket as any);
      // 回放历史对话
      try {
        const hist = session.shortTermHistory;
        if (hist) {
          for (const line of hist.split("\n")) {
            if (line.startsWith("用户:")) socket.send(JSON.stringify({ type:"chat:user", data:{text:line.slice(3)} }));
            else if (line.startsWith("AI:")) socket.send(JSON.stringify({ type:"llm:token", data:{text:line.slice(3)} }));
          }
        }
      } catch {}
      // 发送当前文件列表
      setTimeout(() => {
        try { socket.send(JSON.stringify({ action:"ls" })); } catch {}
      }, 500);

      socket.on("message", async (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.action === "ls") {
            const wsDir = process.env.TAICODE_CWD ?? process.cwd();
            const dir = path.resolve(msg.dir || wsDir);
            try {
              const entries = await readdir(dir, { withFileTypes: true });
              const items = entries
                .filter(e => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "__pycache__")
                .map(e => e.isDirectory() ? e.name + "/" : e.name);
              socket.send(JSON.stringify({ type: "filelist", data: { dir, items, root: wsDir } }));
            } catch { socket.send(JSON.stringify({ type: "filelist", data: { dir, items: [] } })); }
          } else if (msg.action === "auto") {
            // 前端本地管理，无需后端
          } else if (msg.action === "log") {
            const { toggleFileLogging } = await import("../core/logger.js");
            toggleFileLogging();
          } else if (msg.action === "open") {
            try {
              const content = await readFile(msg.path, "utf-8");
              socket.send(JSON.stringify({ type: "fileopen", data: { path: msg.path, content } }));
            } catch { socket.send(JSON.stringify({ type: "fileopen", data: { path: msg.path, content: "(无法读取)" } })); }
          } else if (msg.action === "save") {
            try {
              await writeFile(msg.path, msg.content, "utf-8");
              socket.send(JSON.stringify({ type: "filesaved", data: { path: msg.path } }));
            } catch {}
          } else if (msg.text) {
            await session.ask(msg.text);
          }
        } catch { /* ignore */ }
      });
    });
  });

  // 启动
  const port = 3000;
  await app.listen({ port });
  console.log(`TAICode Web → http://localhost:${port}`);
  return app;
}
