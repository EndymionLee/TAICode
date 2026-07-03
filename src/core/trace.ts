/**
 * 轻量 Trace — 统一 spanId 关联 messages / logs / events / audit
 *
 * 不引入 OpenTelemetry，纯内存 context 传播。
 * 一个 traceId = 一次用户请求，一个 spanId = 一个 Worker step 或工具调用。
 */

let _seq = 0;
function next(): number { return ++_seq; }

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

/** 模块级当前 span（简单全局，非 AsyncLocalStorage） */
let _current: SpanContext | null = null;

export function currentSpan(): SpanContext | null {
  return _current;
}

export function newTrace(): SpanContext {
  const ctx: SpanContext = { traceId: `tr-${next()}`, spanId: `sp-${next()}` };
  _current = ctx;
  return ctx;
}

export function newSpan(parent?: SpanContext, label?: string): SpanContext {
  const ctx: SpanContext = {
    traceId: parent?.traceId || _current?.traceId || `tr-${next()}`,
    spanId: `sp-${next()}`,
    parentSpanId: parent?.spanId || _current?.spanId,
  };
  _current = ctx;
  return ctx;
}

/** 格式化到日志前缀 */
export function spanPrefix(ctx?: SpanContext | null): string {
  const c = ctx || _current;
  if (!c) return "";
  return `[${c.traceId}/${c.spanId}]`;
}

/** 重置当前 span（任务结束时调用） */
export function clearSpan(): void {
  _current = null;
}
