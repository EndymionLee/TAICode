/**
 * 嵌入向量 — 本地模型 → API → n-gram 三级降级
 */
import { pipeline } from "@xenova/transformers";
import { createLogger } from "../logger.js";

const log = createLogger("llm:embed");

let _localEmbedder: any = null;
let _localEmbedderLoading: Promise<any> | null = null;

async function getLocalEmbedder(): Promise<any> {
  if (_localEmbedder) return _localEmbedder;
  if (_localEmbedderLoading) return _localEmbedderLoading;
  _localEmbedderLoading = (async () => {
    try {
      log.info("加载本地嵌入模型 Xenova/all-MiniLM-L6-v2 (~80MB)...");
      _localEmbedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      log.info("本地嵌入模型加载完成");
      return _localEmbedder;
    } catch (e) {
      log.warn("本地模型加载失败:", (e as Error).message);
      _localEmbedderLoading = null;
      return null;
    }
  })();
  return _localEmbedderLoading;
}

async function embedLocal(texts: string[]): Promise<number[][]> {
  const model = await getLocalEmbedder();
  if (!model) throw new Error("本地模型不可用");
  const results: number[][] = [];
  for (const text of texts) {
    const output = await model(text, { pooling: "mean", normalize: true });
    results.push(Array.from(output.data as Float32Array));
  }
  return results;
}

function embedNgram(texts: string[]): number[][] {
  return texts.map(makeLocalVector);
}

function makeLocalVector(text: string): number[] {
  const s = text.toLowerCase().replace(/\s+/g, " ").trim();
  const DIM = 128;
  const vec = new Array(DIM).fill(0);
  for (let i = 0; i < s.length - 1; i++) {
    vec[(s.charCodeAt(i) * 256 + s.charCodeAt(i + 1)) % DIM] += 1;
  }
  for (let i = 0; i < s.length - 2; i++) {
    vec[(s.charCodeAt(i) * 65536 + s.charCodeAt(i + 1) * 256 + s.charCodeAt(i + 2)) % DIM] += 0.5;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

export async function embedMany(input: string | string[], chatModel: any): Promise<number[][]> {
  const inputs = Array.isArray(input) ? input : [input];
  if (inputs.length === 0) return [];

  // 1. 本地模型
  try {
    const r = await embedLocal(inputs);
    if (r.length > 0 && r[0]?.length > 0) return r;
  } catch { /* fall through */ }

  // 2. API
  try {
    const embModel = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
    const baseURL = chatModel.client?.baseURL ?? "https://api.openai.com/v1";
    const apiKey = chatModel.client?.apiKey ?? process.env.OPENAI_API_KEY;
    const resp = await fetch(`${baseURL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: embModel, input: inputs }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as any;
    const embeddings: number[][] = Array.isArray(data.data)
      ? data.data.map((item: any) => item.embedding ?? item)
      : [];
    if (embeddings.length > 0) return embeddings;
  } catch { /* fall through */ }

  // 3. n-gram 兜底
  return embedNgram(inputs);
}
