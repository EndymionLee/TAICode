/**
 * File Refs — Unicode 健壮文件引用提取测试
 * 覆盖: 中文文件名 / 多级扩展名 / 路径 basename / 误报排除 / completedFiles 后缀匹配
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFileRefs, extractFileRefKeys, fileKey, isRegisteredFile } from "../src/core/file-refs.js";

test("基础: 常见扩展名命中", () => {
  const refs = extractFileRefs("创建 calculator.py 和 test_calculator.py");
  assert.deepEqual(refs, ["calculator.py", "test_calculator.py"]);
});

test("中文文件名命中 (旧正则漏配)", () => {
  const refs = extractFileRefs("创建 计算器.py 与 数据加载器.py");
  assert.deepEqual(refs, ["计算器.py", "数据加载器.py"]);
});

test("多级扩展名不截断 (旧正则截成 my.test)", () => {
  const refs = extractFileRefs("写 my.test.ts");
  assert.deepEqual(refs, ["my.test.ts"]);
});

test("路径取 basename (与旧行为一致)", () => {
  const refs = extractFileRefs("修改 src/utils/helper.ts 和 .\\app\\main.tsx");
  assert.deepEqual(refs, ["helper.ts", "main.tsx"]);
});

test("版本号/缩写/数字误报排除", () => {
  assert.deepEqual(extractFileRefs("升级到 v1.2 使用 e.g 之类的缩写 1.5亿 参数"), []);
  assert.deepEqual(extractFileRefs("node 20.10.0"), []);
});

test("未知扩展名 Tier B: 名称含数字/下划线/中文才接受", () => {
  assert.deepEqual(extractFileRefs("生成 file_01.datx"), ["file_01.datx"]);
  assert.deepEqual(extractFileRefs("生成 报表.abc"), ["报表.abc"]);
  assert.deepEqual(extractFileRefs("word.xyz 不算"), []); // 纯小写英文+未知扩展名
});

test("带引号/反引号包裹", () => {
  const refs = extractFileRefs("写入 `config.yml` 和 \"README.md\"");
  assert.ok(refs.includes("config.yml"));
  assert.ok(refs.includes("README.md"));
});

test("fileKey 归一化", () => {
  assert.equal(fileKey("Utils\\Helper.TS"), "utils/helper.ts");
});

test("extractFileRefKeys 去重归一", () => {
  const keys = extractFileRefKeys("改 A.py 再改 a.py");
  assert.deepEqual(keys, ["a.py"]);
});

test("isRegisteredFile: basename 直查 + 相对路径后缀匹配 (修复旧代码永不命中)", () => {
  const completedFiles = { "cc/a.py": { created: true }, "readme.md": { created: true } };
  assert.equal(isRegisteredFile(completedFiles, "a.py"), true);   // 后缀匹配命中
  assert.equal(isRegisteredFile(completedFiles, "cc/a.py"), true); // 直查命中
  assert.equal(isRegisteredFile(completedFiles, "b.py"), false);
});
