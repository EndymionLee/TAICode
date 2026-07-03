/**
 * FrameScheduler — 帧批量调度器
 *
 * 位置: Event Layer 与 Render Layer 之间
 * 职责: 收集同一帧(16ms)内的多次 requestFlush() 调用，合并为一次通知。
 *       解决 "每个事件一次 React re-render" 的问题。
 *
 * 使用:
 *   1. state.ts 中每次 emit() → 改为 frameScheduler.requestFlush()
 *   2. app.tsx 的 subscribe 回调注册到 frameScheduler.onFlush()
 */

type FlushListener = () => void;

class FrameScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly frameMs = 16; // ~60fps, 足够合并同一 tick 内的事件
  private listeners = new Set<FlushListener>();

  /**
   * 请求一次帧刷新。在 frameMs 内的多次调用合并为一次通知。
   * 零参数 — state 层只需调用此方法，无需传 mutation 函数。
   */
  requestFlush(): void {
    if (this.timer) return; // 已调度，合并
    this.timer = setTimeout(() => {
      this.timer = null;
      this.notify();
    }, this.frameMs);
  }

  /**
   * 注册帧刷新监听器。返回取消函数。
   * 通常由 React 的 subscribe 回调调用。
   */
  onFlush(fn: FlushListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * 强制立即刷新，跳过 16ms 窗口。
   * 用于关键事件（初始化完成、shutdown 等）。
   */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

export const frameScheduler = new FrameScheduler();
