import { safeSourceTransportDiagnostic, type SourceVideoTransportDiagnostic } from '../../shared/clipmentor-source-video';
import { getLocale } from '../i18n/locale';
import { isCopyReviewFailure, type CopyReviewFailure } from '../../shared/clipmentor-copy-review';

export interface ToolExecutionOutcome {
  readonly success: boolean;
  readonly result: unknown;
}
export interface PersistedToolFailure {
  readonly name: string;
  readonly reason: string;
}

function recordResult(result: unknown): Record<string, unknown> | null {
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
}

interface CopyReviewToolFailure {
  source_diagnostic?: never;
  error: string;
  operationId: string;
  diagnostic: CopyReviewFailure;
  requestsAttempted: CopyReviewFailure['requestsAttempted'];
  production_approved: false;
}

interface SourceObservationToolFailure {
  error: 'Source observation failed; read the saved receipt, do not retry';
  operationId: string;
  source_diagnostic: SourceVideoTransportDiagnostic;
  requestsSent?: 0 | 1 | 'unknown';
  receipt_persisted?: boolean;
  source_phase?: 'prepare' | 'gateway_request' | 'validate_response' | 'save_result';
  source_error_code?: 'source_observation_failed_or_unknown' | 'source_observation_validation_failed' | 'source_receipt_persist_failed';
  diagnostic?: never;
  requestsAttempted: 1;
  production_approved: false;
}
type StructuredToolFailure = CopyReviewToolFailure | SourceObservationToolFailure;

/** Retain only the closed, identity-bound diagnostic, never arbitrary error data. */
export function structuredToolFailure(value: unknown): StructuredToolFailure | undefined {
  if (value instanceof ToolResultError) return value.result;
  const item = recordResult(value);
  // The source tool returns a receipt; only its closed transport projection crosses failed-tool settlement.
  const r=recordResult(item?.receipt);
  const source=recordResult(item?.source_diagnostic);
  const op=r?.operationId ?? item?.operationId;
  const d=typeof op==='string'?safeSourceTransportDiagnostic(r?.transport_diagnostic??source,'',op):undefined;
  const sent=r?.requestsSent??item?.requestsSent,persisted=r?.receipt_persisted??item?.receipt_persisted;
  const phase=r?.phase??item?.source_phase,code=r?.error??item?.source_error_code;
  if(item && isFailedToolResult(item) && item.error==='Source observation failed; read the saved receipt, do not retry' && d
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(String(op))
    && ((r?.status==='failed' && r.requestsAttempted===1 && r.actual_handoff_verified===false && r.complete_film_accepted===false)
      || (!r && item?.requestsAttempted===1 && item.production_approved===false))) {
    return {error:'Source observation failed; read the saved receipt, do not retry',operationId:String(op),
      source_diagnostic:d,requestsAttempted:1,production_approved:false,
      ...([0,1,'unknown'].includes(sent as any)?{requestsSent:sent as 0|1|'unknown'}:{}),
      ...(typeof persisted==='boolean'?{receipt_persisted:persisted}:{}),
      ...(['prepare','gateway_request','validate_response','save_result'].includes(phase as any)?{source_phase:phase as SourceObservationToolFailure['source_phase']}:{}),
      ...(['source_observation_failed_or_unknown','source_observation_validation_failed','source_receipt_persist_failed'].includes(code as any)?{source_error_code:code as SourceObservationToolFailure['source_error_code']}:{})};
  }
  if (!item || !isFailedToolResult(item) || typeof item.error !== 'string'
    || item.production_approved !== false || !isCopyReviewFailure(item.diagnostic)
    || typeof item.operationId !== 'string' || item.operationId !== item.diagnostic.operationId
    || item.requestsAttempted !== item.diagnostic.requestsAttempted) return;
  return { error: item.error, operationId: item.operationId, diagnostic: item.diagnostic,
    requestsAttempted: item.diagnostic.requestsAttempted, production_approved: false };
}

/** The promise still rejects; metadata does not turn a failed tool into success. */
export class ToolResultError extends Error {
  readonly result: StructuredToolFailure;
  constructor(result: StructuredToolFailure) {
    super(result.error);
    this.name = 'ToolResultError';
    this.result = result;
  }
}

/** Tool handlers may report a rejected operation as data instead of throwing. */
export function isFailedToolResult(result: unknown): boolean {
  const record = recordResult(result);
  if (!record) return false;
  if (record.ok === false || record.success === false || record.aborted === true) return true;
  return typeof record.error === 'string'
    && record.error.trim().length > 0
    && record.ok !== true
    && record.success !== true;
}

export function toolFailureReason(result: unknown): string {
  if (result instanceof Error) return result.message.trim() || result.name;
  const record = recordResult(result);
  if (record) {
    for (const field of ['error', 'message', 'note'] as const) {
      const value = record[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  if (typeof result === 'string' && result.trim()) return result.trim();
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** A successful retry of the same tool resolves its latest failure. */
export class ToolFailureTracker {
  readonly #unresolved = new Map<string, string>();

  record(name: string, outcome: ToolExecutionOutcome): void {
    const result = recordResult(outcome.result);
    if (outcome.success && result?.denied === true) return;
    if (outcome.success) this.#unresolved.delete(name);
    else this.#unresolved.set(name, toolFailureReason(outcome.result));
  }

  get hasUnresolved(): boolean {
    return this.#unresolved.size > 0;
  }

  clear(): void {
    this.#unresolved.clear();
  }

  snapshot(): PersistedToolFailure[] {
    return [...this.#unresolved].map(([name, reason]) => ({ name, reason }));
  }

  restore(value: unknown): void {
    this.clear();
    if (!Array.isArray(value)) return;
    for (const entry of value.slice(0, 64)) {
      if (!entry || typeof entry !== 'object') continue;
      const { name, reason } = entry as { name?: unknown; reason?: unknown };
      if (typeof name !== 'string' || !name.trim() || name.length > 256) continue;
      if (typeof reason !== 'string' || !reason.trim()) continue;
      this.#unresolved.set(name, reason.slice(0, 4_096));
    }
  }

  report(): string {
    const details = [...this.#unresolved]
      .map(([name, reason]) => `${name}: ${reason}`)
      .join('; ');
    const locale = getLocale();
    if (locale === 'zh') {
      return `有工具调用失败，未能完成请求（${details}）。本次没有成功执行的记录。`;
    }
    if (locale === 'ru') {
      return `Запрос не выполнен из-за сбоя инструмента (${details}). Успешное выполнение этой операции не зафиксировано.`;
    }
    return `I couldn't complete the requested operation because a tool failed (${details}). No success was recorded for the failed operation.`;
  }
}
