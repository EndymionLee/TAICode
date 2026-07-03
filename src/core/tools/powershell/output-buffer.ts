/**
 * OutputBuffer — 防止上下文爆炸, 截断长输出
 *
 * 策略: 保留前 100 行 + 后 100 行, 中间截断。
 * 总上限 ~16KB (~2000 行纯 ASCII)。
 */

const MAX_LINES = 200;
const HEAD_LINES = 100;
const TAIL_LINES = 100;

export class OutputBuffer {
  private lines: string[] = [];
  private _truncated = false;

  append(chunk: string): void {
    const parts = chunk.split("\n");
    for (const part of parts) {
      this.lines.push(part);
    }
    if (this.lines.length > MAX_LINES) {
      this._truncated = true;
    }
  }

  getResult(): { stdout: string; truncated: boolean } {
    if (!this._truncated || this.lines.length <= MAX_LINES) {
      return { stdout: this.lines.join("\n"), truncated: false };
    }
    const head = this.lines.slice(0, HEAD_LINES);
    const tail = this.lines.slice(-TAIL_LINES);
    const skipped = this.lines.length - HEAD_LINES - TAIL_LINES;
    const middle = `\n... [截断 ${skipped} 行] ...\n`;
    return {
      stdout: head.join("\n") + middle + tail.join("\n"),
      truncated: true,
    };
  }

  clear(): void {
    this.lines = [];
    this._truncated = false;
  }
}
