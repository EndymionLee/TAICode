/**
 * Observation — 机械观察注入 (Planner/Splitter 免 ReAct 观察的统一实现)
 *
 * 浅层 readdir(含一层子目录名) → 生成《工作区现状》块:
 *   ≤50 项 → 机械清单直接注入 (省 2-4 次 ls/read_file 观察往返)
 *   >50 项 → 返回 null, 走正常 ReAct 观察
 * 指纹(条目+mtime hash)附带返回, 供调用方缓存/日志。
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

export interface Observation {
  /** 注入 prompt 的现状块 (含"无需再观察"指令); null=条目过多, 走 ReAct */
  note: string | null;
  /** 目录指纹 (条目名+mtime) */
  fingerprint: string;
  entries: number;
}

const MAX_ENTRIES = 50;

export function buildObservation(ws: string): Observation {
  let top: fs.Dirent[];
  try { top = fs.readdirSync(ws, { withFileTypes: true }); }
  catch { return { note: null, fingerprint: "", entries: -1 }; }

  const filtered = top.filter((e) => e.name !== ".TAI" && !e.name.startsWith("."));
  if (filtered.length === 0) {
    return {
      note: `\n\n[工作区现状] 当前目录为空。\n以上即全部信息, 无需再用 ls/read_file 观察, 直接输出最终 JSON。`,
      fingerprint: hashOf([]),
      entries: 0,
    };
  }
  if (filtered.length > MAX_ENTRIES) {
    return { note: null, fingerprint: "", entries: filtered.length };
  }

  // 一层展开: 文件直列, 目录补一层子条目计数
  const lines: string[] = [];
  const fpParts: string[] = [];
  for (const e of filtered) {
    const full = path.join(ws, e.name);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
    fpParts.push(`${e.name}:${mtime}`);
    if (e.isDirectory()) {
      let sub = "";
      try {
        const kids = fs.readdirSync(full).slice(0, 8);
        sub = kids.length ? ` (内含: ${kids.join(", ")}${fs.readdirSync(full).length > 8 ? " ..." : ""})` : " (空)";
      } catch { /* ignore */ }
      lines.push(`- ${e.name}/${sub}`);
    } else {
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* ignore */ }
      lines.push(`- ${e.name} (${size}B)`);
    }
  }

  return {
    note: `\n\n[工作区现状] 当前目录浅层清单 (含一层子目录):\n${lines.join("\n")}\n以上即全部现状, 无需再用 ls/read_file 观察, 直接输出最终 JSON。`,
    fingerprint: hashOf(fpParts),
    entries: filtered.length,
  };
}

function hashOf(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
}
