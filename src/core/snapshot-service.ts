/**
 * Snapshot Service — 全局共享的增量文件系统快照服务
 *
 * 旧实现缺陷: 每个 Worker 每步 takeSnapshot(≤5000 文件全目录扫描),
 * 8 Worker 并发时大仓库 IO 会炸 (30s 超时兜底等于自认)。
 *
 * 本服务:
 *   - 进程级单例, 全部 Worker 共享一份基线快照 (引用计数 acquire/release)
 *   - fs.watch recursive 增量维护 dirty 集, getSnapshot() 时才统一 stat 刷新
 *   - watch 不可用 (旧内核/权限) → 自动降级为防抖全量重扫 (≥3s 间隔)
 *   - 合并视图带缓存, 仅在 dirty/基线变化时重建 — getSnapshot 无变化时零 IO
 */
import * as fs from "fs";
import * as path from "path";
import { createLogger } from "./logger.js";

const log = createLogger("core:snapshot");

export interface FileEntry { mtime: number; size: number }
export type Snapshot = Record<string, FileEntry>;

const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", ".TAI",
  ".idea", ".vscode", "dist", "build", ".next", ".nuxt",
  "coverage", ".cache",
]);

const MAX_FILES = 5000;
const BASELINE_TIMEOUT_MS = 30_000;
const RESCAN_DEBOUNCE_MS = 3_000;
const DIRTY_FLUSH_BATCH = 2000;
const OVERLAY_COMPACT_THRESHOLD = 4000;

/** 全量扫描 (仅基线/降级重扫时调用) */
export async function scanSnapshot(root: string): Promise<Snapshot> {
  const snap: Snapshot = {};
  const stack: string[] = [root];
  let fileCount = 0;
  while (stack.length > 0 && fileCount < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          snap[fullPath.replace(/\\/g, "/")] = { mtime: stat.mtimeMs, size: stat.size };
          fileCount++;
        } catch { /* 文件在读前被删 */ }
      }
    }
  }
  return snap;
}

/** 对比两份快照的变更数 (worker 活动检测用) */
export function countSnapshotDiff(before: Snapshot, after: Snapshot): number {
  let changes = 0;
  for (const [fp, info] of Object.entries(after)) {
    const prev = before[fp];
    if (!prev || prev.mtime !== info.mtime || prev.size !== info.size) changes++;
  }
  for (const fp of Object.keys(before)) {
    if (!after[fp]) changes++;
  }
  return changes;
}

class SnapshotService {
  private root: string | null = null;
  private refCount = 0;
  private base: Snapshot = {};
  /** overlay: 路径 → 新状态 (null = 已删除) */
  private overlay = new Map<string, FileEntry | null>();
  private dirtyPaths = new Set<string>();
  private watcher: fs.FSWatcher | null = null;
  private watchBroken = false;
  private lastFullScan = 0;
  private scanning: Promise<void> | null = null;
  private mergedCache: Snapshot | null = null;

  /** Worker 进入时调用; 首个引用建立基线 + watcher */
  async acquire(root: string): Promise<void> {
    this.root = root.replace(/\\/g, "/");
    this.refCount++;
    if (this.refCount > 1 && this.base && (this.watcher || this.watchBroken)) return;

    // 基线扫描 (带超时保护, 失败降级为空基线 — 与旧行为一致)
    try {
      this.base = await Promise.race([
        scanSnapshot(this.root),
        new Promise<Snapshot>((resolve) => setTimeout(() => resolve({}), BASELINE_TIMEOUT_MS)),
      ]);
      log.info(`基线快照: ${Object.keys(this.base).length} 个文件`);
    } catch (e) {
      log.warn(`基线快照失败: ${(e as Error).message}, 使用空基线`);
      this.base = {};
    }
    this.overlay.clear();
    this.dirtyPaths.clear();
    this.mergedCache = null;
    this.lastFullScan = Date.now();
    this.startWatcher();
  }

  /** Worker 退出时调用; 最后一个引用释放 watcher */
  async release(): Promise<void> {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0) this.stopWatcher();
  }

  private startWatcher(): void {
    if (!this.root || this.watcher || this.watchBroken) return;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const full = path.join(this.root!, String(filename)).replace(/\\/g, "/");
        // 跳过监听目录之外无需精确: recursive watch 只报 root 内事件
        this.dirtyPaths.add(full);
        this.mergedCache = null;
      });
      this.watcher.on("error", (err) => {
        log.warn(`fs.watch 失败, 降级为防抖重扫: ${(err as Error).message}`);
        this.watchBroken = true;
        this.stopWatcher();
      });
      log.info("增量监听已启动 (fs.watch recursive)");
    } catch (e) {
      log.warn(`fs.watch 不可用, 降级为防抖重扫: ${(e as Error).message}`);
      this.watchBroken = true;
    }
  }

  private stopWatcher(): void {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
  }

  /** 刷新 dirty 集 → overlay (惰性, getSnapshot 时统一做, 批量上限防饥饿) */
  private async flushDirty(): Promise<void> {
    if (this.dirtyPaths.size === 0 || !this.root) return;
    const batch = Array.from(this.dirtyPaths).slice(0, DIRTY_FLUSH_BATCH);
    for (const p of batch) this.dirtyPaths.delete(p);
    await Promise.all(batch.map(async (full) => {
      try {
        const stat = await fs.promises.stat(full);
        this.overlay.set(full, { mtime: stat.mtimeMs, size: stat.size });
      } catch {
        this.overlay.set(full, null); // 删除或不可读
      }
    }));
    this.mergedCache = null;
  }

  /** overlay 过大 → 后台全量重扫压缩 (不阻塞调用方) */
  private compactInBackground(): void {
    if (this.overlay.size < OVERLAY_COMPACT_THRESHOLD || this.scanning || !this.root) return;
    const root = this.root; // 闭包内属性窄化会失效, 先捕获
    this.scanning = (async () => {
      try {
        this.base = await scanSnapshot(root);
        this.overlay.clear();
        this.mergedCache = null;
        this.lastFullScan = Date.now();
        log.info(`快照压缩重扫: ${Object.keys(this.base).length} 个文件`);
      } finally {
        this.scanning = null;
      }
    })();
  }

  /** 获取当前快照视图 (共享, 只读约定: 调用方不得修改返回对象) */
  async getSnapshot(): Promise<Snapshot> {
    if (!this.root) return {};

    // 降级路径: watch 不可用 + 距上次全量超过防抖窗口 → 重扫
    if (this.watchBroken && !this.scanning && Date.now() - this.lastFullScan > RESCAN_DEBOUNCE_MS) {
      this.scanning = (async () => {
        try {
          this.base = await scanSnapshot(this.root!);
          this.overlay.clear();
          this.mergedCache = null;
          this.lastFullScan = Date.now();
        } finally {
          this.scanning = null;
        }
      })();
      await this.scanning;
    }

    await this.flushDirty();
    this.compactInBackground();

    if (this.mergedCache) return this.mergedCache;
    if (this.overlay.size === 0) {
      this.mergedCache = this.base;
      return this.base;
    }
    const merged: Snapshot = { ...this.base };
    for (const [fp, entry] of this.overlay) {
      if (entry === null) delete merged[fp];
      else merged[fp] = entry;
    }
    this.mergedCache = merged;
    return merged;
  }
}

/** 进程级共享单例 — 全部 Worker 复用 */
export const sharedSnapshotService = new SnapshotService();
