/**
 * Semaphore — 轻量并发控制
 */
export class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(count: number) {
    this.permits = count;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    const next = this.queue.shift();
    if (next) next();
  }
}
