export { CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS, CLIPMENTOR_ANALYSIS_TOOL_NAMES } from './schemas/clipmentor-analysis-tools';
import type { AgentContext } from '../context';
import { checkAnalysisHandoff, invalidateChangedReviews, isAnalysisActor, isClipMentorAnalysis, pointDigest } from '../../clipmentor/analysis';
import teashellHistorical from '../../clipmentor/fixtures/teashell-historical.json';
import { importTeashellAnalysis } from '../../clipmentor/import-teashell';
import { transcribeClipMentorAsset } from '../../clipmentor/transcribe-source';
import { observeClipMentorSource } from '../../clipmentor/observe-source';
import { requestSourceVideo, readSourceVideo } from '../../clipmentor/request-source-video';
import { requestClipMentorCopyReview } from '../../clipmentor/request-copy-review';
import { appendAnalysisFindings, OBSERVATION_ID_MISMATCH } from '../../clipmentor/append-findings';
import { checkCopyProduction, copyReviewSubject, isCopyProductionReview } from '../../clipmentor/production-gate';
import { checkSourceBreakdown, isSourceBreakdown, breakdownRevisionError } from '../../clipmentor/source-breakdown';

type Args = Record<string, unknown>;
export async function execClipMentorAnalysisTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'read_clipmentor_source_video') return readSourceVideo(args, ctx);
  if (name === 'observe_clipmentor_source_video') return requestSourceVideo(args, ctx);
  if (name === 'request_clipmentor_copy_review') return requestClipMentorCopyReview(args, ctx);
  if (name === 'transcribe_clipmentor_source') return transcribeClipMentorAsset(args, ctx);
  if (name === 'observe_clipmentor_source') return observeClipMentorSource(args, ctx);
  const doc = ctx.getDoc();
  if (name === 'read_clipmentor_analysis') {
    const view = args.view ?? 'full';
    if (!['full', 'source_breakdown', 'current_copy', 'evidence', 'copy_review'].includes(String(view))) return { error: 'Invalid analysis read view' };
    if (view !== 'copy_review' && args.reviewPart !== undefined) return { error: 'reviewPart requires the copy_review view' };
    const a = doc.clipMentorAnalysis;
    const selected = a?.blueprint.filter((unit) => args.unitId === undefined || unit.unit_id === args.unitId) ?? [];
    if (view !== 'copy_review' && args.unitId !== undefined && (typeof args.unitId !== 'string' || !selected.length)) return { error: 'Analysis unit not found' };
    const evidenceIds = args.evidenceIds;
    if (view === 'evidence' && (!Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.length > 8
      || !evidenceIds.every((id) => typeof id === 'string' && id.trim()))) return { error: 'Evidence view requires 1–8 existing evidenceIds' };
    if (view !== 'evidence' && evidenceIds !== undefined) return { error: 'evidenceIds requires the evidence view' };
    if (view === 'copy_review') {
      const part = args.reviewPart ?? 'result';
      if (!['result', 'packet'].includes(String(part))) return { error: 'Invalid reviewPart' };
      if (part === 'packet' && typeof args.unitId !== 'string') return { error: 'Read the frozen review packet one unit at a time with unitId' };
      const receipt = a?.production_copy_review;
      if (args.unitId !== undefined && (typeof args.unitId !== 'string' || !receipt?.units.some((unit) => unit.unit_id === args.unitId))) return { error: 'Review unit not found' };
      let binding = receipt ? 'unverifiable' : 'missing';
      if (isCopyProductionReview(receipt)) {
        try {
          const subject = await copyReviewSubject(doc);
          binding = receipt.analysis_revision === subject.revision && receipt.content_digest === subject.digest ? 'current' : 'stale';
        } catch { /* Keep the historical result readable without claiming a current binding. */ }
      }
      const { teaching_review, ...metadata } = receipt ?? {};
      const matches = (unit: { unit_id: string }) => args.unitId === undefined || unit.unit_id === args.unitId;
      const units = teaching_review?.packet.units.filter(matches) ?? [];
      const ids = new Set(units.flatMap((unit) => unit.points.flatMap((point) => point.evidence_ids)));
      const operationId = receipt?.reviewer_run_id.match(/^clipmentor-review:([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/)?.[1] ?? null;
      return {
        analysis: { copy_review: { operation_id: operationId, binding, unit_filter: args.unitId ?? null,
          receipt: receipt ? { ...metadata, units: receipt.units.filter(matches) } : null,
          ...(part === 'result' ? { teaching_review: teaching_review ? { units: teaching_review.review.units.filter(matches) } : null } : {}),
          packet_included: part === 'packet',
          ...(part === 'packet' ? { packet: teaching_review ? { ...teaching_review.packet, units,
            source_evidence: teaching_review.packet.source_evidence.filter((entry) => ids.has(entry.evidence_id)) } : null } : {}) } },
        revision: a?.revision ?? 0, production_gate: await checkCopyProduction(doc, ctx.getCreativeMode()),
      };
    }
    const evidence = view === 'evidence' ? a?.evidence.filter((entry) => (evidenceIds as string[]).includes(entry.evidence_id)) ?? [] : [];
    if (view === 'evidence' && (evidenceIds as string[]).some((id) => !evidence.some((entry) => entry.evidence_id === id))) return { error: 'Requested evidence not found' };
    const linkedIds = new Set(evidence.flatMap((entry) => entry.supporting_evidence_ids));
    const linked = a?.evidence.filter((entry) => linkedIds.has(entry.evidence_id)) ?? [];
    const observationIds = new Set([...evidence, ...linked].map((entry) => entry.observation_id).filter(Boolean));
    const current = selected.map((unit) => {
      const internal = (unit as unknown as { internal_review?: Record<string, unknown> }).internal_review;
      const id = internal?.current_script_candidate;
      const pictureId = internal?.current_picture_plan;
      return { unit_id: unit.unit_id, line_guidance: unit.line_guidance, candidate_id: typeof id === 'string' ? id : null,
        candidate: typeof id === 'string' ? internal?.[id] : null,
        picture_plan_id: typeof pictureId === 'string' ? pictureId : null,
        picture_plan: typeof pictureId === 'string' ? internal?.[pictureId] ?? null : null };
    });
    return {
      analysis: view === 'full' ? a ?? null : view === 'source_breakdown'
        ? { source: a?.source ?? null, product: a?.product ?? null, source_breakdown: a?.source_breakdown ?? null }
        : view === 'evidence' ? { source: a?.source ?? null, evidence, linked_evidence: linked,
          missing_linked_evidence_ids: [...linkedIds].filter((id) => !linked.some((entry) => entry.evidence_id === id)),
          observations: a?.observations?.filter((entry) => observationIds.has(entry.observation_id)) ?? [] }
        : { current_copy: current },
      revision: a?.revision ?? 0,
      handoff: await checkAnalysisHandoff(doc),
      production_gate: await checkCopyProduction(doc, ctx.getCreativeMode()),
      breakdown_check: checkSourceBreakdown(doc),
      breakdown_timeline_check: checkSourceBreakdown(doc, true),
    };
  }
  if (!['revise_clipmentor_analysis', 'review_clipmentor_analysis'].includes(name)) return { error: 'Unknown analysis tool' };
  if (!isAnalysisActor(args.actor) || typeof args.reason !== 'string' || !args.reason.trim()) return { error: 'Declared operator, executor, instruction and reason are required' };
  const revision = doc.clipMentorAnalysis?.revision ?? 0;
  if (args.expectedRevision !== revision) return { error: 'Analysis revision conflict; read again', revision };
  try {
    let a = doc.clipMentorAnalysis ? structuredClone(doc.clipMentorAnalysis) : undefined;
    const now = Date.now();
    if (name === 'revise_clipmentor_analysis' && args.action === 'append') {
      if (!a) return { error: 'Source analysis required before findings' };
      if (!a.source.sourceContentHash || doc.assets.find((v) => v.id === a!.source.asset_id)?.sourceContentHash !== a.source.sourceContentHash) return { error: 'Source hash missing or changed; findings not applied' };
      a = await appendAnalysisFindings(a, args.records, args.actor, args.reason);
    } else if (name === 'revise_clipmentor_analysis' && args.action === 'import') {
      if (a) return { error: 'Analysis already exists; use record revisions instead of overwriting it' };
      if (typeof args.assetId !== 'string') return { error: 'assetId required' };
      if (args.fixture !== undefined && (args.fixture !== 'teashell_historical_v1' || args.input !== undefined)) return { error: 'Use either the bundled Teashell fixture or JSON input, not both' };
      a = importTeashellAnalysis(args.fixture === 'teashell_historical_v1' ? teashellHistorical : args.input, args.assetId, args.actor, now);
      a.audit[0].reason = args.reason;
      const asset = doc.assets.find((s) => s.id === args.assetId);
      if (!asset?.sourceContentHash || asset.sourceContentHash !== a.source.sourceContentHash) return { error: 'Import source hash missing or mismatched' };
    } else {
      if (!a) return { error: 'No analysis imported' };
      if (name === 'review_clipmentor_analysis') {
        if (!['confirmed', 'needs_revision'].includes(String(args.state))) return { error: 'Invalid review state' };
        const point = a.points.find((p) => p.point_id === args.pointId);
        if (!point) return { error: 'Point not found' };
        const check = await checkAnalysisHandoff(doc);
        // Review state itself is expected to be pending. Only structural/source issues block a confirmation.
        if (args.state === 'confirmed' && check.issues.some((i) => !i.code.startsWith('point_') || i.code === 'point_without_evidence')) return { error: 'Resolve source/reference/time issues before confirmation', handoff: check };
        const review = { point_id: point.point_id, state: args.state as 'confirmed' | 'needs_revision',
          content_digest: await pointDigest(a, point.point_id), source_hash: a.source.sourceContentHash,
          actor: args.actor, at: now, reason: args.reason };
        a.reviews = [...a.reviews.filter((r) => r.point_id !== point.point_id), review];
      } else if (args.action === 'select_copy_lines') {
        const unit = a.blueprint.find((entry) => entry.unit_id === args.id);
        const input = args.record as Record<string, unknown> | undefined;
        const internal = (unit as unknown as { internal_review?: Record<string, unknown> } | undefined)?.internal_review;
        if (!unit || !internal || !input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some((key) => !['source_candidate_id', 'candidate_id', 'line_ids', 'plan_id', 'plan', 'line_guidance'].includes(key))
          || input.source_candidate_id !== internal.current_script_candidate
          || typeof input.candidate_id !== 'string' || !/^script_candidate_[A-Za-z0-9_-]+$/.test(input.candidate_id)
          || Object.hasOwn(internal, input.candidate_id)
          || typeof input.plan_id !== 'string' || !/^picture_plan_[A-Za-z0-9_-]+$/.test(input.plan_id) || Object.hasOwn(internal, input.plan_id)
          || !Array.isArray(input.line_ids) || !input.line_ids.length || !input.line_ids.every((id) => typeof id === 'string')
          || new Set(input.line_ids).size !== input.line_ids.length
          || !input.plan || typeof input.plan !== 'object' || Array.isArray(input.plan)
          || typeof input.line_guidance !== 'string' || !input.line_guidance.trim()) return { error: 'Existing current copy, distinct existing line IDs, new script_candidate_/picture_plan_ IDs, plan and guidance required; no new wording accepted' };
        if (!a.source.sourceContentHash || doc.assets.find((asset) => asset.id === a!.source.asset_id)?.sourceContentHash !== a.source.sourceContentHash
          || checkSourceBreakdown(doc).status !== 'structurally_ready') return { error: 'Resolve source identity and breakdown before selecting copy' };
        const source = internal[input.source_candidate_id as string] as { lines?: Array<Record<string, unknown>> };
        const selectedIds = input.line_ids as string[];
        const lines = selectedIds.map((id) => source?.lines?.find((line) => line.id === id));
        const plan = input.plan as Record<string, unknown>;
        const planned = plan.selected_narration;
        if (lines.some((line) => !line) || !Array.isArray(planned) || planned.length !== lines.length
          || planned.some((line, i) => !line || typeof line !== 'object' || ['id', 'narration_ms', 'caption_lines', 'zh', 'point_ids', 'source_seconds'].some((key) => JSON.stringify(line[key]) !== JSON.stringify(lines[i]![key])))) return { error: 'Selection and selected_narration must reuse the same ordered existing lines verbatim' };
        const covered = new Set(lines.flatMap((line) => Array.isArray(line!.point_ids) ? line!.point_ids : typeof line!.point === 'string' ? [line!.point] : unit.point_ids));
        if (a.source_breakdown!.units.find((entry) => entry.unit_id === unit.unit_id)!.coverage.some((entry) => entry.treatment === 'explain' && !covered.has(entry.point_id))) return { error: 'Selection would remove a registered teaching point; nothing changed' };
        internal[input.candidate_id] = { status: 'candidate', review_status: 'pending', production_allowed: false,
          lines: structuredClone(lines), base_revision: a.revision,
          selection: { source_candidate_id: input.source_candidate_id, line_ids: [...input.line_ids],
            excluded_line_ids: source.lines!.filter((line) => !selectedIds.includes(String(line.id))).map((line) => line.id), reason: args.reason } };
        internal[input.plan_id] = { ...structuredClone(plan), status: 'candidate', review_status: 'pending', production_allowed: false,
          script_candidate_id: input.candidate_id, source_binding: structuredClone(a.source), base_analysis_revision: a.revision,
          selection_activation: { status: 'active_selection_not_production_approval', formal_candidate_id: input.candidate_id,
            source_candidate_id: input.source_candidate_id, actual_selected_line_ids: [...input.line_ids], production_allowed: false } };
        internal.current_script_candidate = input.candidate_id;
        internal.current_picture_plan = input.plan_id;
        unit.line_guidance = input.line_guidance;
        await invalidateChangedReviews(a);
      } else if (args.action === 'set_picture_plan') {
        const unit = a.blueprint.find((entry) => entry.unit_id === args.id);
        const input = args.record as Record<string, unknown> | undefined;
        const internal = (unit as unknown as { internal_review?: Record<string, unknown> } | undefined)?.internal_review;
        if (!unit || !input || typeof input !== 'object' || Array.isArray(input) || !internal
          || typeof input.plan_id !== 'string' || !/^picture_plan_[A-Za-z0-9_-]+$/.test(input.plan_id)
          || Object.hasOwn(internal, input.plan_id) || typeof internal.current_script_candidate !== 'string'
          || input.script_candidate_id !== internal.current_script_candidate
          || !input.plan || typeof input.plan !== 'object' || Array.isArray(input.plan)
          || typeof input.line_guidance !== 'string' || !input.line_guidance.trim()) return { error: 'New picture_plan_ ID, matching current script, plan object and line_guidance required; history is never overwritten' };
        if (checkSourceBreakdown(doc).status !== 'structurally_ready') return { error: 'Resolve source breakdown before saving a picture plan', breakdown_check: checkSourceBreakdown(doc) };
        internal[input.plan_id] = { ...structuredClone(input.plan as Record<string, unknown>),
          status: 'candidate', review_status: 'pending', production_allowed: false,
          script_candidate_id: internal.current_script_candidate, source_binding: structuredClone(a.source), base_analysis_revision: a.revision };
        internal.current_picture_plan = input.plan_id;
        unit.line_guidance = input.line_guidance;
        await invalidateChangedReviews(a);
      } else if (args.action === 'set_source_breakdown') {
        if (!isSourceBreakdown(args.record)) return { error: 'Invalid source breakdown; nothing changed' };
        const error = breakdownRevisionError(a.source_breakdown, args.record);
        if (error) return { error };
        a.source_breakdown = structuredClone(args.record);
        const check = checkSourceBreakdown({ ...doc, clipMentorAnalysis: a });
        // Incomplete coverage is saved as pending so the Agent can read and repair it; invalid references are not evidence.
        if (check.issues.some((i) => ['source_hash_missing_or_changed', 'segment_time_out_of_bounds', 'segment_evidence_kind_or_reference', 'segment_evidence_outside_range', 'point_segment_missing', 'unit_segment_missing', 'breakdown_unit_missing', 'coverage_point_missing', 'supporting_primary_missing', 'unrecognized_unit_field', 'original_playback_out_of_bounds', 'original_segment_outside_playback'].includes(i.code))) return { error: 'Resolve breakdown source/reference issues before saving', breakdown_check: check };
        await invalidateChangedReviews(a);
      } else {
        if (args.action !== 'revise' || !['evidence', 'points', 'blueprint', 'transcripts'].includes(String(args.collection))) return { error: 'Invalid revision collection/action' };
        const collection = args.collection as 'evidence' | 'points' | 'blueprint' | 'transcripts';
        const key = { evidence: 'evidence_id', points: 'point_id', blueprint: 'unit_id', transcripts: 'source_id' }[collection];
        const rows = a[collection] as unknown as Record<string, unknown>[];
        const index = rows.findIndex((r) => r[key] === args.id);
        let replacement = args.record;
        if (args.wordIndex !== undefined || args.endSeconds !== undefined) {
          const transcript = a.transcripts.find((t) => t.source_id === args.id);
          if (collection !== 'transcripts' || args.record !== undefined || !transcript
            || !Number.isSafeInteger(args.wordIndex) || Number(args.wordIndex) < 0
            || Number(args.wordIndex) >= transcript.words.length || typeof args.endSeconds !== 'number'
            || !Number.isFinite(args.endSeconds) || args.endSeconds < transcript.words[Number(args.wordIndex)].start_seconds
            || args.endSeconds > a.source.duration_seconds) return { error: 'Invalid transcript word-end revision; nothing changed' };
          replacement = { ...transcript, words: transcript.words.map((word, i) => (
            i === args.wordIndex ? { ...word, end_seconds: args.endSeconds as number } : word
          )) };
        }
        if (index < 0 || !replacement || typeof replacement !== 'object' || Array.isArray(replacement)
          || (replacement as Record<string, unknown>)[key] !== args.id) return { error: 'Replace an existing record without changing its ID' };
        rows[index] = structuredClone(replacement) as Record<string, unknown>;
        if (!isClipMentorAnalysis(a)) return { error: 'Invalid analysis record; nothing changed' };
        await invalidateChangedReviews(a);
      }
      a.revision += 1;
      a.audit.push({ revision: a.revision, action: name === 'review_clipmentor_analysis' ? String(args.state) : args.action === 'set_source_breakdown' ? 'set_source_breakdown' : args.action === 'set_picture_plan' ? 'set_picture_plan' : 'revise',
        target_id: args.action === 'set_source_breakdown' ? 'source_breakdown' : args.wordIndex === undefined ? String(args.pointId ?? args.id) : `${String(args.id)}:words:${String(args.wordIndex)}`, actor: args.actor, at: now, reason: args.reason });
    }
    if (!isClipMentorAnalysis(a)) return { error: 'Invalid analysis schema; nothing changed' };
    const candidate = (unit: unknown) => {
      const review = (unit as { internal_review?: Record<string, unknown> } | undefined)?.internal_review;
      const id = review?.current_script_candidate;
      return typeof id === 'string' ? JSON.stringify({ id, value: review![id] }) : undefined;
    };
    const writingCopy = a.blueprint.some((u) => candidate(u) !== undefined
      && candidate(u) !== candidate(doc.clipMentorAnalysis?.blueprint.find((old) => old.unit_id === u.unit_id)));
    if (writingCopy && !a.source_breakdown) return { error: 'Register source_breakdown before writing or replacing a copy candidate; existing manuscripts remain readable', breakdown_check: checkSourceBreakdown({ ...doc, clipMentorAnalysis: a }) };
    // Recheck after asynchronous hashing; never overwrite concurrent project changes.
    if (ctx.getDoc() !== doc) return { error: 'Project changed during analysis write; read again' };
    const next = { ...doc, clipMentorAnalysis: a };
    const handoff = await checkAnalysisHandoff(next);
    if (ctx.getDoc() !== doc) return { error: 'Project changed during analysis write; read again' };
    ctx.commands.applyDoc(next);
    return { ok: true, revision: a.revision, handoff, breakdown_check: checkSourceBreakdown(next), identity: 'local_declared_not_authenticated' };
  } catch (error) {
    // Only this static domain error is exposed; arbitrary input/errors remain redacted.
    if (error instanceof Error && error.message === OBSERVATION_ID_MISMATCH) return { error: OBSERVATION_ID_MISMATCH };
    return { error: 'Analysis input could not be validated; nothing changed' };
  }
}
