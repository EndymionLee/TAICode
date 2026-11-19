/**
 * TUI Layout — 对话布局纯函数层
 *
 * 设计 (用户视角):
 *   user      → 右侧圆角气泡 (≤68% 列宽, 一眼区分"我说的话", 视线锚点在右)
 *   assistant → 左侧 ● 头像 + 纯文本折行 (长回复阅读优先, 不加框)
 *   thought   → 右对齐 dim 小字 (耗时标签, 像聊天时间戳, 不占阅读动线)
 *   info      → 原样 (banner / 空行分隔)
 *
 * 测量 (measureGroup) 与渲染 (MessageArea) 共用同一 wrap —
 * 修复旧版"按满宽测高 vs 实际渲染高度"错位导致的滚动裁剪错误。
 * 窄终端 (cols < 50): 气泡退化为右缩进无框 (小屏不挤)。
 */
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import type { Line, LineKind } from "./state.js";

export interface MessageGroup {
  id: number;          // 组首行 id (React key)
  kind: LineKind;
  lines: string[];     // 组内文本行 (已去尾空行)
}

/** 连续同 kind 的行合为一组; 组尾空行吞并; info 空行保留为空行组 (消息间距) */
export function groupLines(lines: Line[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let cur: MessageGroup | null = null;
  for (const l of lines) {
    if (cur && cur.kind === l.kind) {
      cur.lines.push(l.text);
    } else {
      cur = { id: l.id, kind: l.kind, lines: [l.text] };
      groups.push(cur);
    }
  }
  // 组尾空行吞并 (非 info 组)
  for (const g of groups) {
    if (g.kind !== "info") {
      while (g.lines.length > 1 && g.lines[g.lines.length - 1].trim() === "") g.lines.pop();
    }
  }
  // 吞并后可能产生相邻同 kind 组 (user "text" + "" + user "text2" 场景空行是 user kind)
  // → 再合并一轮
  const merged: MessageGroup[] = [];
  for (const g of groups) {
    const last = merged[merged.length - 1];
    if (last && last.kind === g.kind && g.kind !== "info") {
      last.lines.push("", ...g.lines);
      while (last.lines.length > 1 && last.lines[last.lines.length - 1].trim() === "") last.lines.pop();
    } else {
      merged.push(g);
    }
  }
  return merged;
}

/** 按显示宽度折行 (中文 2 宽; 保留显式 \n; ANSI 剥离) */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of stripAnsi(text).split("\n")) {
    if (rawLine === "") { out.push(""); continue; }
    let cur = "";
    let curW = 0;
    for (const ch of rawLine) {
      const w = stringWidth(ch);
      if (w === 0) continue; // 零宽字符跳过
      if (curW + w > width && cur !== "") {
        out.push(cur);
        cur = ch === " " ? "" : ch; // 行首空格不保留
        curW = cur ? w : 0;
      } else {
        cur += ch;
        curW += w;
      }
    }
    out.push(cur);
  }
  return out.length > 0 ? out : [""];
}

export function bubbleWidth(cols: number): number {
  return Math.max(10, Math.min(cols - 10, Math.floor(cols * 0.68)));
}

export function assistantWidth(cols: number): number {
  return Math.max(10, cols - 4);
}

export interface GroupLayout {
  group: MessageGroup;
  /** 折行后的渲染行 (user/assistant); thought/info 为原文行 */
  wrapped: string[];
  /** 视觉高度 (含边框/空行) */
  height: number;
}

/** 单组布局: 折行 + 测高 (与渲染严格同源) */
export function layoutGroup(group: MessageGroup, cols: number): GroupLayout {
  const narrow = cols < 50;
  switch (group.kind) {
    case "user": {
      // 宽屏: 气泡内宽 = bubbleWidth - 2(padding); 窄屏: cols-4 (› 前缀 2 + 右缘 2)
      const width = narrow ? cols - 4 : bubbleWidth(cols) - 2;
      const wrapped = wrapText(group.lines.join("\n"), width);
      // 宽屏: 圆角框上下各 1 行; 窄屏退化: 无框
      return { group, wrapped, height: wrapped.length + (narrow ? 0 : 2) };
    }
    case "assistant": {
      const wrapped = wrapText(group.lines.join("\n"), assistantWidth(cols));
      return { group, wrapped, height: wrapped.length };
    }
    case "thought": {
      // 每条一行 (耗时标签)
      const wrapped = group.lines.filter((l) => l.trim() !== "");
      return { group, wrapped: wrapped.length ? wrapped : [""], height: Math.max(1, wrapped.length) };
    }
    case "info":
    default: {
      // 原样不折行 (banner 按设计宽度; 空行为空行)
      return { group, wrapped: group.lines, height: group.lines.length };
    }
  }
}

/** 滚动窗口: 从底部取 maxLines 可见高度, 按组为单位 (组不切半, 滚动视觉稳定) */
export function scrollWindow(layouts: GroupLayout[], maxLines: number, scrollOffset: number): GroupLayout[] {
  const total = layouts.reduce((s, l) => s + l.height, 0);
  const clamped = Math.min(Math.max(0, scrollOffset), Math.max(0, total - maxLines));

  // 从底部向上, 先跳过 clamped 个视觉行 (整组跳过), 再装满 maxLines
  const visible: GroupLayout[] = [];
  let toSkip = clamped;
  let used = 0;
  for (let i = layouts.length - 1; i >= 0; i--) {
    const h = layouts[i].height;
    if (toSkip > 0) {
      toSkip -= h;
      // offset 落在组中间: 仍整组跳过 (粗粒度但视觉稳定), 不裁半组
      continue;
    }
    if (used + h > maxLines) break;
    used += h;
    visible.unshift(layouts[i]);
  }
  return visible;
}
