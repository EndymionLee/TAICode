/**
 * TUI Layout — 分组/折行/测高/滚动窗口测试
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupLines, wrapText, layoutGroup, scrollWindow, bubbleWidth, assistantWidth } from "../src/tui/layout.js";
import type { Line } from "../src/tui/state.js";

const L = (id: number, text: string, kind: Line["kind"]): Line => ({ id, text, kind });

test("groupLines: 连续同 kind 合组, 组尾空行吞并, user 空行场景再合并", () => {
  const lines = [
    L(1, "banner1", "info"), L(2, "banner2", "info"), L(3, "", "info"),
    L(4, "你好", "user"), L(5, "", "user"),
    L(6, "● 回复", "assistant"), L(7, "第二行", "assistant"), L(8, "", "info"),
    L(9, "  Thought for 3s", "thought"),
  ];
  const g = groupLines(lines);
  assert.equal(g.length, 5);
  assert.deepEqual(g[0].lines, ["banner1", "banner2", ""]); // info 原样
  assert.deepEqual(g[1].lines, ["你好"]);                     // user 尾空行吞并
  assert.deepEqual(g[2].lines, ["● 回复", "第二行"]);
  assert.equal(g[3].kind, "info");
  assert.equal(g[4].kind, "thought");
});

test("wrapText: 中文按显示宽度折行 (2宽/字)", () => {
  const text = "创建计算器项目".repeat(6); // 7字×6=42字 = 84 显示宽
  const out = wrapText(text, 20);          // 20/20/20/20/4 → 5 行
  assert.equal(out.length, 5);
  for (const l of out) assert.ok(l.length <= 10); // 每行 ≤10 个中文字
});

test("wrapText: 保留显式换行与空行", () => {
  assert.deepEqual(wrapText("a\n\nb", 40), ["a", "", "b"]);
});

test("wrapText: 英文单词按字符宽度截断", () => {
  const out = wrapText("abcdefghij", 4);
  assert.deepEqual(out, ["abcd", "efgh", "ij"]);
});

test("layoutGroup: user 气泡 = wrap行数+2边框 (宽屏), assistant 无框, thought 滤空行", () => {
  const user = layoutGroup({ id: 1, kind: "user", lines: ["你好", "世界"] }, 80);
  assert.equal(user.height, 2 + 2);

  const ai = layoutGroup({ id: 2, kind: "assistant", lines: ["a", "b", "c"] }, 80);
  assert.equal(ai.height, 3);

  const th = layoutGroup({ id: 3, kind: "thought", lines: ["  Thought for 3s", "", "  ✻ x"] }, 80);
  assert.equal(th.height, 2);
});

test("layoutGroup: 窄屏 (<50列) user 气泡退化无框", () => {
  const user = layoutGroup({ id: 1, kind: "user", lines: ["你好"] }, 40);
  assert.equal(user.height, 1);
});

test("bubbleWidth/assistantWidth: 上限与下限", () => {
  assert.equal(bubbleWidth(100), 68);
  assert.equal(bubbleWidth(200), 136);       // ≤68%
  assert.ok(bubbleWidth(30) >= 10);          // 下限保护
  assert.equal(assistantWidth(80), 76);
});

test("scrollWindow: 组不切半, 底部对齐, offset clamp", () => {
  const mk = (id: number, h: number) => layoutGroup(
    { id, kind: "assistant", lines: Array.from({ length: h }, () => "x") }, 80);

  const layouts = [mk(1, 2), mk(2, 3), mk(3, 2)];
  // 容量 5: 底部取 → 组2+组3 (5行), 组1 整组排除
  const v1 = scrollWindow(layouts, 5, 0);
  assert.deepEqual(v1.map((v) => v.group.id), [2, 3]);

  // offset 2 (跳过组3 的 2 行 → 组3 整组跳过): 组1+组2
  const v2 = scrollWindow(layouts, 5, 2);
  assert.deepEqual(v2.map((v) => v.group.id), [1, 2]);

  // 超界 clamp: total=7, maxLines=5 → clamp(999)=2, 与 v2 相同
  const v3 = scrollWindow(layouts, 5, 999);
  assert.deepEqual(v3.map((v) => v.group.id), [1, 2]);
});
