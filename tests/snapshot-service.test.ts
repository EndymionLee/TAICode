/**
 * Snapshot Service — 共享增量快照测试
 * 覆盖: 基线采集 / 增量更新 (watch dirty flush) / diff 统计 / 引用计数释放
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { scanSnapshot, countSnapshotDiff, sharedSnapshotService } from "../src/core/snapshot-service.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("countSnapshotDiff: 新增/修改/删除全计数", () => {
  const before = { "a.txt": { mtime: 1, size: 10 }, "b.txt": { mtime: 1, size: 10 } };
  const after = {
    "a.txt": { mtime: 2, size: 10 },  // 修改
    "b.txt": { mtime: 1, size: 10 },  // 不变
    "c.txt": { mtime: 1, size: 5 },   // 新增
  };
  assert.equal(countSnapshotDiff(before, after), 2);
  assert.equal(countSnapshotDiff(after, after), 0);
  assert.equal(countSnapshotDiff(after, before), 2); // 删除 c.txt + 改回 a.txt
});

test("scanSnapshot: 采集文件 + 跳过 .git/node_modules", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-snap-"));
  fs.writeFileSync(path.join(dir, "a.py"), "x", "utf-8");
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "x", "utf-8");
  const snap = await scanSnapshot(dir);
  const keys = Object.keys(snap);
  assert.equal(keys.length, 1);
  assert.ok(keys[0].endsWith("a.py"));
});

test("共享服务: 基线 → 增量变更反映到快照 (watch dirty flush)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-snap-live-"));
  fs.writeFileSync(path.join(dir, "base.txt"), "hello", "utf-8");

  await sharedSnapshotService.acquire(dir);
  try {
    const s1 = await sharedSnapshotService.getSnapshot();
    const k1 = Object.keys(s1);
    assert.equal(k1.length, 1);
    assert.ok(k1[0].endsWith("base.txt"));

    // 变更: 新文件 + 修改 + 删除
    fs.writeFileSync(path.join(dir, "new.py"), "print(1)", "utf-8");
    fs.writeFileSync(path.join(dir, "base.txt"), "hello world changed", "utf-8");
    fs.appendFileSync(path.join(dir, "base.txt"), "!");
    await sleep(700); // 等 watch 事件入 dirty 集 (事件传播有延迟)

    const s2 = await sharedSnapshotService.getSnapshot(); // 触发 dirty flush
    const key = (p: string) => path.join(dir, p).replace(/\\/g, "/");
    assert.ok(s2[key("new.py")], "新文件应出现在增量快照");
    assert.ok(s2[key("base.txt")].size > 5, "修改应反映新 size");
  } finally {
    await sharedSnapshotService.release();
  }
});

test("引用计数: 两次 acquire 两次 release 后可再次 acquire", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taicode-snap-rc-"));
  fs.writeFileSync(path.join(dir, "x.txt"), "x", "utf-8");
  await sharedSnapshotService.acquire(dir);
  await sharedSnapshotService.acquire(dir);
  await sharedSnapshotService.release();
  await sharedSnapshotService.release();
  await sharedSnapshotService.acquire(dir);
  const snap = await sharedSnapshotService.getSnapshot();
  assert.equal(Object.keys(snap).length, 1);
  await sharedSnapshotService.release();
});
