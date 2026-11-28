import type { ProjectDoc } from '../../src/editor/types';
import { isClipMentorAnalysis } from '../../src/clipmentor/analysis';
import { copyPreparationReady, prepareSourceBreakdownWrite } from '../../src/clipmentor/source-breakdown';
import { teachingPointGaps, type teachingBaselineSource } from './production-teaching-baseline';
import { digestValue } from '../agent-runs/store-values';
import { redactTextForAgentRuntime } from '../../src/agent/runtime-artifact';

type Event = { type: string; data: unknown };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Only the uncommitted, evidence-only supplement can be lost. A failed change to
// a selected point, an unknown tool outcome, or a concurrent write cannot be adopted.
export function recoveredAnalysisWrite(doc: ProjectDoc, events: readonly Event[], error: string,
  sourceFor: (doc: ProjectDoc) => ReturnType<typeof teachingBaselineSource>) {
  const analysis = doc.clipMentorAnalysis;
  if (!isClipMentorAnalysis(analysis) || !analysis.points.length || !analysis.blueprint.length ||
      analysis.source_breakdown?.review_scope?.kind !== 'full_source' || !copyPreparationReady(doc)) return;
  const revision = analysis.revision;
  const unresolved = new Set<string>();
  const pending = new Map<string, Record<string, unknown>>();
 const reportedError = redactTextForAgentRuntime(error);
  let registered: string | undefined;
  let rejected: string | undefined;
  for (const event of events) {
    if (event.type !== 'server-tool-request' && event.type !== 'server-tool-result') continue;
    const data = record(event.data);
    if (typeof data.toolCallId !== 'string' || typeof data.name !== 'string') return;
    if (event.type === 'server-tool-result') {
      const key=typeof data.referenceOperation==='string'?data.name+'\0'+data.referenceOperation:data.name;
      if (data.success === true) unresolved.delete(key);
      else unresolved.add(key);
    }
    if (['read_clipmentor_analysis', 'read_clipmentor_references', 'read_agent_artifact', 'read_project', 'load_skill'].includes(String(data.name))) continue;
    if (event.type === 'server-tool-request') {
      if (pending.size) return; // Overlapping writes have no unambiguous publication order.
      pending.set(data.toolCallId, data);
      continue;
    }
    const request = pending.get(data.toolCallId);
    if (!request || request.name !== data.name || !request.args || request.argsDigest !== data.argsDigest ||
        request.argsDigest !== digestValue(request.args)) return;
    pending.delete(data.toolCallId);
    const args = record(request.args), result = record(data.result);
    if (data.name === 'revise_clipmentor_analysis' && args.action === 'set_source_breakdown' &&
        (record(args.record).review_scope === undefined || record(record(args.record).review_scope).kind === 'full_source') &&
        data.success === true && result.ok === true && result.revision === revision && args.expectedRevision === revision - 1) {
      const prepared = prepareSourceBreakdownWrite(args.record);
      if (!prepared.issues.length &&
          digestValue({...record(prepared.record), review_scope:analysis.source_breakdown.review_scope}) === digestValue(analysis.source_breakdown)) {
        registered = data.toolCallId;
        rejected = undefined;
        continue;
      }
    }
    const fields = record(args.records);
    if (registered && data.name === 'revise_clipmentor_analysis' && args.action === 'append' &&
        args.expectedRevision === revision && Object.keys(fields).length === 1 && Array.isArray(fields.evidence) && fields.evidence.length &&
        fields.evidence.every(item => record(item).kind === 'operator_supplied') &&
        data.success === false && typeof result.error === 'string' && /nothing changed\.?$/i.test(result.error) &&
        reportedError.includes('revise_clipmentor_analysis: ' + redactTextForAgentRuntime(result.error))) {
      rejected = data.toolCallId;
      continue;
    }
    registered = rejected = undefined;
  }
  if (!registered || !rejected || pending.size || unresolved.size !== 1 || !unresolved.has('revise_clipmentor_analysis') ||
      teachingPointGaps(sourceFor(doc), doc).length) return;
  return { registeredWrite:registered, rejectedSupplement:rejected, analysisRevision:revision };
}

/** Ignore prose and point ordering when the validator identified the failed fields. */
export function sourceBreakdownFailures(stop: AbortController) {
  const seen = new Set<string>();
  return (name: string, args: Record<string, unknown>, result: unknown) => {
    if (name !== 'revise_clipmentor_analysis' || args.action !== 'set_source_breakdown') return;
    const failure = record(result);
    if (failure.error !== 'Invalid source breakdown; nothing changed') return;
    const fields = Array.isArray(failure.issues) ? failure.issues.map(entry => {
      const { point_id, field, code } = record(entry);
      return JSON.stringify([point_id, field, code]);
    }).sort() : [];
    const identity = digestValue([args.expectedRevision, fields.length ? fields : args.record]);
    if (seen.has(identity)) stop.abort(new Error('production_source_breakdown_no_progress'));
    else seen.add(identity);
  };
}

/** One explicit recovery of the legacy format failure before any analysis was published. */
export function failedInitialBreakdownWrite(task: import('./production-task').ProductionTask) {
  return task.input.humanBlueprintReview === true && task.input.authorBackend === 'codex'
    && !!task.input.panelDelivery && task.stage === 'analysis' && task.status === 'blocked'
    && task.repairs === 0 && task.projectRevision === undefined && !task.teachingAnalysisPublication
    && !Object.keys(task.completed).length && task.attempts.model === 1
    && Object.entries(task.attempts).every(([kind, count]) => kind === 'model' || count === 0)
    && Object.keys(task.effects).length === 1 && task.effects['analysis:initial:0:author-0']?.status === 'completed'
    && !!task.error?.includes('revise_clipmentor_analysis: Invalid source breakdown; nothing changed');
}
