import {labelTranslationsShape} from '../../clipmentor/author-translations';
export { CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS, CLIPMENTOR_ANALYSIS_TOOL_NAMES } from './schemas/clipmentor-analysis-tools';
import type { AgentContext } from '../context';
import { canonicalProjectJson } from '../external-edit-session';
import type { ProjectDoc } from '../../editor/types';
import { checkAnalysisHandoff, invalidateChangedReviews, isAnalysisActor, isClipMentorAnalysis, pointDigest, pointReviewTargetDigest } from '../../clipmentor/analysis';
import teashellHistorical from '../../clipmentor/fixtures/teashell-historical.json';
import { importTeashellAnalysis } from '../../clipmentor/import-teashell';
import {importNativeBlueprint,BlueprintImportError} from '../../clipmentor/import-blueprint';
import { transcribeClipMentorAsset } from '../../clipmentor/transcribe-source';
import { readClipMentorSourceAsr } from '../../clipmentor/read-source-asr';
import { observeClipMentorSource } from '../../clipmentor/observe-source';
import { requestSourceVideo, readSourceVideo } from '../../clipmentor/request-source-video';
import { editClipMentorPreview } from '../../clipmentor/preview-edit';
import { requestPreviewReview } from '../../clipmentor/request-preview-review';
import { requestClipMentorCopyReview } from '../../clipmentor/request-copy-review';
import { appendAnalysisFindings, OBSERVATION_ID_MISMATCH } from '../../clipmentor/append-findings';
import { checkCopyProduction, copyReviewSubject, isCopyProductionReview } from '../../clipmentor/production-gate';
import { checkSourceBreakdown, copyPreparationReady, isSourceBreakdown, breakdownRevisionError, blueprintRevisionError, selectedPointChanges, copyLineKeys } from '../../clipmentor/source-breakdown';
import { deliveryPictureBindings } from '../../clipmentor/delivery-sections';
import {deliverySectionsFromDoc,missingDeliverySectionKinds}from'../../clipmentor/delivery-bindings';
import {readClipMentorStoryboard} from '../../clipmentor/read-storyboard';
import {renderClipMentorReviewBoard} from '../../clipmentor/render-review-board';

type Args = Record<string, unknown>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const pointReviewIssues = new Set(['point_pending', 'point_needs_revision', 'point_stale']);

function captureAnalysisSnapshot(ctx: AgentContext, liveDoc: ProjectDoc, signal: AbortSignal | undefined) {
  const projectId = ctx.getProjectId?.();
  const runId = ctx.getAgentRunId?.();
  const doc = structuredClone(liveDoc);
  const base = canonicalProjectJson(doc);
  const isCurrent = (live = ctx.getDoc(), expected = base) =>
    !signal?.aborted && ctx.getAgentRunSignal?.() === signal
    && ctx.getProjectId?.() === projectId && ctx.getAgentRunId?.() === runId
    && canonicalProjectJson(live) === expected;
  return { doc, isCurrent, projectId };
}

export async function execClipMentorAnalysisTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if(name==='render_clipmentor_review_board')return renderClipMentorReviewBoard(ctx,args.view);
  if (name === 'edit_clipmentor_preview') return editClipMentorPreview(args, ctx);
  if (name === 'review_clipmentor_preview') return requestPreviewReview(args, ctx);
  if (name === 'read_clipmentor_source_video') return readSourceVideo(args, ctx);
  if (name === 'observe_clipmentor_source_video') return requestSourceVideo(args, ctx);
  if (name === 'request_clipmentor_copy_review') return requestClipMentorCopyReview(args, ctx);
  if (name === 'transcribe_clipmentor_source') return transcribeClipMentorAsset(args, ctx);
  if (name === 'observe_clipmentor_source') return observeClipMentorSource(args, ctx);
  if (name === 'read_clipmentor_analysis') {
    const view = args.view ?? 'full';
    if (args.pointId !== undefined && (view !== 'full' || !text(args.pointId) || args.unitId !== undefined)) return { error: 'pointId requires the full analysis view and one exact point ID' };
    if(view==='source_asr')return readClipMentorSourceAsr(args,ctx);
    if(args.operationId!==undefined||args.assetId!==undefined)return {error:'operationId/assetId require the source_asr view'};
    if(view==='storyboard'){
      if(['reviewPart','copyPart','packetOffset','packetLimit','packetDigest','evidenceIds'].some(key=>args[key]!==undefined))return{error:'storyboard does not accept copy/review/evidence paging arguments'};
      return readClipMentorStoryboard(args,ctx);
    }
    if(['boardPart','boardDigest','boardOffset'].some(key=>args[key]!==undefined))return{error:'board arguments require the storyboard view'};
    if (!(typeof view === 'string' && ['full', 'source_breakdown', 'current_copy', 'evidence', 'copy_review'].includes(view))) return { error: 'Invalid analysis read view' };
    if (view !== 'copy_review' && args.reviewPart !== undefined) return { error: 'reviewPart requires the copy_review view' };
    if (view !== 'current_copy' && args.copyPart !== undefined) return { error: 'copyPart requires the current_copy view' };
    const evidenceIds = args.evidenceIds;
    if (view === 'evidence' && (!Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.length > 8
      || !evidenceIds.every((id) => typeof id === 'string' && id.trim()))) return { error: 'Evidence view requires 1–8 existing evidenceIds' };
    if (view !== 'evidence' && evidenceIds !== undefined) return { error: 'evidenceIds requires the evidence view' };
    const pagingRequested = ['packetOffset', 'packetLimit', 'packetDigest'].some((key) => args[key] !== undefined);
    if (pagingRequested && (view !== 'copy_review' || args.reviewPart !== 'packet')) return { error: 'Packet paging requires copy_review with reviewPart=packet' };
    const copyPart = args.copyPart ?? 'all';
    if (view === 'current_copy' && (!(typeof copyPart === 'string' && ['all', 'summary', 'candidate', 'picture_plan'].includes(copyPart))
      || (copyPart !== 'all' && typeof args.unitId !== 'string'))) return { error: 'A valid copyPart and unitId are required for a narrow current-copy read' };
    const part = args.reviewPart ?? 'result';
    if (view === 'copy_review') {
      if (part !== 'result' && part !== 'packet') return { error: 'Invalid reviewPart' };
      if (part === 'packet' && typeof args.unitId !== 'string') return { error: 'Read the frozen review packet one unit at a time with unitId' };
    }
    const offset = args.packetOffset === undefined ? 0 : args.packetOffset;
    const limit = args.packetLimit === undefined ? 6000 : args.packetLimit;
    if (pagingRequested) {
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 256 || Number(limit) > 6000
        || (args.packetOffset === undefined && (args.packetLimit !== undefined || args.packetDigest !== undefined))) return { error: 'Use packetOffset >= 0 and packetLimit 256–6000 (UTF-16 characters)' };
      if ((Number(offset) > 0 && args.packetDigest === undefined)
        || (args.packetDigest !== undefined && (typeof args.packetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(args.packetDigest)))) return { error: 'Continue with packetDigest from the first page; do not mix frozen reviews' };
    }
    const stale = { error: 'Project or run changed during analysis read; read again' };
    const signal = ctx.getAgentRunSignal?.();
    if (signal?.aborted) return stale;
    const { doc, isCurrent, projectId } = captureAnalysisSnapshot(ctx, ctx.getDoc(), signal);
    const mode = ctx.getCreativeMode();
    const finishRead = (result: unknown) => isCurrent() && ctx.getCreativeMode() === mode ? result : stale;
    const a = doc.clipMentorAnalysis;
    if (typeof args.pointId === 'string') {
      const point = a?.points.find(entry => entry.point_id === args.pointId);
      if (!a || !point) return { error: 'Analysis point not found' };
      const contentDigest = await pointDigest(a, point.point_id);
      const digest = await pointReviewTargetDigest(a, projectId, contentDigest);
      if (JSON.stringify(point).length > 12_000) {
        return finishRead({ revision: a.revision, point_review_target: { digest, point_omitted: true,
          note: 'The point body exceeds the tool output budget. Inspect the full point before recording a decision.' } });
      }
      return finishRead({ revision: a.revision, point_review_target: { point_id: point.point_id, digest, point } });
    }
    const selected = a?.blueprint.filter((unit) => args.unitId === undefined || unit.unit_id === args.unitId) ?? [];
    if (view !== 'copy_review' && args.unitId !== undefined && (typeof args.unitId !== 'string' || !selected.length)) return { error: 'Analysis unit not found' };
    if (view === 'copy_review') {
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
      const ids = new Set(units.flatMap((unit) => [...unit.points.flatMap((point) => point.evidence_ids), ...(unit.source_context?.evidence_ids ?? [])]));
      const operationId = receipt?.reviewer_run_id.match(/^clipmentor-review:([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/)?.[1] ?? null;
      const productionGate = await checkCopyProduction(doc, mode);
      const result = {
        analysis: { copy_review: { operation_id: operationId, binding, unit_filter: args.unitId ?? null,
          receipt: receipt ? { ...metadata, units: receipt.units.filter(matches) } : null,
          ...(part === 'result' ? { teaching_review: teaching_review ? { units: teaching_review.review.units.filter(matches) } : null } : {}),
          packet_included: part === 'packet',
          ...(part === 'packet' ? { packet: teaching_review ? { ...teaching_review.packet, units,
            source_evidence: teaching_review.packet.source_evidence.filter((entry) => ids.has(entry.evidence_id)) } : null } : {}) } },
        revision: a?.revision ?? 0, production_gate: productionGate,
      };
      // Keep small legacy reads unchanged. Large reads page the exact frozen input, never a summary
      // of its picture plan. 12k leaves headroom below the model's 16k result budget.
      if (part !== 'packet' || (!pagingRequested && JSON.stringify(result).length <= 12_000)) return finishRead(result);
      if (!receipt || !teaching_review) return { error: 'No frozen review packet is available' };
      // Shared source evidence is retained verbatim. Filtering only by point IDs would lose context-only observations.
      const serialized = JSON.stringify({ operation_id: operationId, analysis_revision: receipt.analysis_revision,
        content_digest: receipt.content_digest, reviewed_at: receipt.reviewed_at,
        reviewer_run_id: receipt.reviewer_run_id, packet: { ...teaching_review.packet, units } });
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
      const digest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (args.packetDigest !== undefined && args.packetDigest !== digest) return { error: 'Frozen packet changed; restart reading from packetOffset=0, not a new review' };
      if (Number(offset) >= serialized.length) return { error: 'packetOffset is outside this frozen packet' };
      const end = Math.min(serialized.length, Number(offset) + Number(limit));
      return finishRead({
        analysis: { copy_review: { operation_id: operationId, binding, unit_filter: args.unitId,
          receipt_summary_only: true,
          receipt: { analysis_revision: receipt.analysis_revision, content_digest: receipt.content_digest,
            reviewed_at: receipt.reviewed_at, verdict: receipt.verdict,
            units: receipt.units.filter(matches).map(({ unit_id, candidate_id, verdict }) => ({ unit_id, candidate_id, verdict })) },
          packet_included: false,
          packet_page: { offset, end_offset: end, total_chars: serialized.length, digest,
            json_text: serialized.slice(Number(offset), end), next_offset: end < serialized.length ? end : null,
            is_last_page: end === serialized.length, read_complete: false,
            note: 'Exact frozen JSON page, not the current replacement. Continue with next_offset and the same digest until null. Concatenate json_text in offset order; a last page does not prove earlier pages were read. Read result separately for all judgments. No new review or approval.' },
        } },
        revision: a?.revision ?? 0, production_gate: productionGate,
      });
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
      const candidate = typeof id === 'string' && object(internal?.[id]) ? internal[id] as Record<string, unknown> : null;
      if (view === 'current_copy' && copyPart !== 'all') return {
        unit_id: unit.unit_id, candidate_id: typeof id === 'string' ? id : null,
        picture_plan_id: typeof pictureId === 'string' ? pictureId : null,
        ...(copyPart === 'summary' ? { line_ids: Array.isArray(candidate?.lines) ? candidate.lines.filter(object).map((line) => line.id) : [] } : {}),
        ...(copyPart === 'candidate' ? { candidate: candidate ? {
          status: candidate.status, review_status: candidate.review_status, production_allowed: candidate.production_allowed,
          lines: Array.isArray(candidate.lines) ? candidate.lines.filter(object).map((line) =>
            Object.fromEntries(copyLineKeys.filter((key) => Object.hasOwn(line, key)).map((key) => [key, line[key]]))) : [],
        } : null } : {}),
        ...(copyPart === 'picture_plan' ? { picture_plan: typeof pictureId === 'string' ? internal?.[pictureId] ?? null : null } : {}),
      };
      return { unit_id: unit.unit_id, line_guidance: unit.line_guidance, candidate_id: typeof id === 'string' ? id : null,
        candidate: typeof id === 'string' ? internal?.[id] : null,
        picture_plan_id: typeof pictureId === 'string' ? pictureId : null,
        picture_plan: typeof pictureId === 'string' ? internal?.[pictureId] ?? null : null };
    });
    const pictureBindings=view==='current_copy'&&(copyPart==='all'||copyPart==='picture_plan')?deliveryPictureBindings(doc):[];
    if (view === 'current_copy' && copyPart !== 'all') return finishRead({
      analysis: { ...(pictureBindings.length?{delivery_picture_bindings:pictureBindings}:{}), current_copy: current }, revision: a?.revision ?? 0,
      production_gate: await checkCopyProduction(doc, mode),
    });
    return finishRead({
      analysis: view === 'full' ? a ?? null : view === 'source_breakdown'
        ? { source: a?.source ?? null, product: a?.product ?? null, source_breakdown: a?.source_breakdown ?? null }
        : view === 'evidence' ? { source: a?.source ?? null, evidence, linked_evidence: linked,
          missing_linked_evidence_ids: [...linkedIds].filter((id) => !linked.some((entry) => entry.evidence_id === id)),
          observations: a?.observations?.filter((entry) => observationIds.has(entry.observation_id)) ?? [] }
        : { ...(pictureBindings.length?{delivery_picture_bindings:pictureBindings}:{}), current_copy: current },
      revision: a?.revision ?? 0,
      handoff: await checkAnalysisHandoff(doc),
      production_gate: await checkCopyProduction(doc, mode),
      breakdown_check: checkSourceBreakdown(doc),
      breakdown_timeline_check: checkSourceBreakdown(doc, true),
    });
  }
  if (!['revise_clipmentor_analysis', 'review_clipmentor_analysis'].includes(name)) return { error: 'Unknown analysis tool' };
  if (!isAnalysisActor(args.actor) || typeof args.reason !== 'string' || !args.reason.trim()) return { error: 'Declared operator, executor, instruction and reason are required' };
  try {
    const stale = { error: 'Project changed or run ended during analysis write; read again' };
    const signal = ctx.getAgentRunSignal?.();
    if (signal?.aborted) return stale;
    const initial = ctx.getDoc();
    const revision = initial.clipMentorAnalysis?.revision ?? 0;
    if (args.expectedRevision !== revision) return { error: 'Analysis revision conflict; read again', revision };
    if (name === 'review_clipmentor_analysis' && (typeof args.expectedPointDigest !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedPointDigest))) {
      return { error: 'Point review requires expectedPointDigest from read_clipmentor_analysis with view=full and pointId' };
    }
    const { doc, isCurrent, projectId } = captureAnalysisSnapshot(ctx, initial, signal);
    let a = doc.clipMentorAnalysis ? structuredClone(doc.clipMentorAnalysis) : undefined;
    const now = Date.now();
    if (name === 'revise_clipmentor_analysis' && args.action === 'append') {
      if (!a) return { error: 'Source analysis required before findings' };
      if (!a.source.sourceContentHash || doc.assets.find((v) => v.id === a!.source.asset_id)?.sourceContentHash !== a.source.sourceContentHash) return { error: 'Source hash missing or changed; findings not applied' };
      a = await appendAnalysisFindings(a, args.records, args.actor, args.reason, doc.assets.filter(asset => asset.kind === 'image').map(asset => asset.id));
    } else if (name === 'revise_clipmentor_analysis' && args.action === 'import') {
      if (a) return { error: 'Analysis already exists; use record revisions instead of overwriting it' };
      if (typeof args.assetId !== 'string') return { error: 'assetId required' };
      if (args.fixture !== undefined && (args.fixture !== 'teashell_historical_v1' || args.input !== undefined)) return { error: 'Use either the bundled Teashell fixture or JSON input, not both' };
      a = args.fixture===undefined?importNativeBlueprint(args.input,args.assetId,doc,args.actor,args.reason,now)??undefined:undefined;
      if(!a){a=importTeashellAnalysis(args.fixture==='teashell_historical_v1'?teashellHistorical:args.input,args.assetId,args.actor,now);a.audit[0].reason=args.reason;}
      const asset = doc.assets.find((s) => s.id === args.assetId);
      if (!asset?.sourceContentHash || asset.sourceContentHash !== a.source.sourceContentHash) return { error: 'Import source hash missing or mismatched' };
    } else {
      if (!a) return { error: 'No analysis imported' };
      if (name === 'review_clipmentor_analysis') {
        if (!(typeof args.state === 'string' && ['confirmed', 'needs_revision'].includes(args.state))) return { error: 'Invalid review state' };
        const point = a.points.find((p) => p.point_id === args.pointId);
        if (!point) return { error: 'Point not found' };
        const contentDigest = await pointDigest(a, point.point_id);
        if (await pointReviewTargetDigest(a, projectId, contentDigest) !== args.expectedPointDigest) return { error: 'Point review target changed; read again and obtain a decision on the current content' };
        const check = await checkAnalysisHandoff(doc);
        // Review state itself is expected to be pending. Only structural/source issues block a confirmation.
        if (args.state === 'confirmed' && check.issues.some((i) => !pointReviewIssues.has(i.code))) return { error: 'Resolve source/reference/time issues before confirmation', handoff: check };
        const review = { point_id: point.point_id, state: args.state as 'confirmed' | 'needs_revision',
          content_digest: contentDigest, source_hash: a.source.sourceContentHash,
          actor: args.actor, at: now, reason: args.reason };
        a.reviews = [...a.reviews.filter((r) => r.point_id !== point.point_id), review];
      } else if (args.action === 'set_copy_candidate') {
        const unit = a.blueprint.find((entry) => entry.unit_id === args.id);
        const input = args.record;
        const review = unit as unknown as { internal_review?: Record<string, unknown> } | undefined;
        if (!unit || !review || (review.internal_review !== undefined && !object(review.internal_review)) || !object(input))
          return { error: 'Registered unit and copy record required' };
        const internal = review.internal_review ?? {};
        const current = internal.current_script_candidate;
        const matchesBase = current === undefined
          ? input.source_candidate_id === null && internal.current_picture_plan === undefined
          : text(current) && object(internal[current]) && input.source_candidate_id === current;
        if (!matchesBase
          || Object.keys(input).some((key) => !['source_candidate_id', 'candidate_id', 'lines', 'plan_id', 'plan', 'line_guidance'].includes(key))
          || !text(input.candidate_id) || !/^script_candidate_[A-Za-z0-9_-]+$/.test(input.candidate_id) || Object.hasOwn(internal, input.candidate_id)
          || !text(input.plan_id) || !/^picture_plan_[A-Za-z0-9_-]+$/.test(input.plan_id) || Object.hasOwn(internal, input.plan_id)
          || !Array.isArray(input.lines) || !input.lines.length || !object(input.plan) || !text(input.line_guidance)) {
          return { error: 'Use source_candidate_id:null for first copy, or the current saved candidate ID for a revision. New script_candidate_/picture_plan_ IDs, complete lines, plan and guidance required' };
        }
        if (!a.source.sourceContentHash || doc.assets.find((asset) => asset.id === a!.source.asset_id)?.sourceContentHash !== a.source.sourceContentHash
          || !copyPreparationReady(doc)) return { error: 'Resolve source identity and breakdown before registering copy' };
        const registered = a.source_breakdown!.units.find((entry) => entry.unit_id === unit.unit_id);
        if (!registered) return { error: 'Register this unit in source_breakdown before writing copy' };
        const pointIds = new Set(registered.coverage.map((entry) => entry.point_id));
        const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');
        const lines = input.lines;
        if (lines.some((line) => !object(line) || Object.keys(line).some((key) => !copyLineKeys.includes(key))
          || !text(line.id) || !text(line.narration_ms) || !text(line.zh)
          || !Array.isArray(line.caption_lines) || !line.caption_lines.length || !line.caption_lines.every(text)
          || normalize(line.narration_ms) !== normalize(line.caption_lines.join(' '))
          || !Array.isArray(line.point_ids) || !line.point_ids.length || !line.point_ids.every((id) => text(id) && pointIds.has(id))
          || new Set(line.point_ids).size !== line.point_ids.length
          || !Array.isArray(line.source_seconds) || line.source_seconds.length !== 2
          || !line.source_seconds.every((s) => typeof s === 'number' && Number.isFinite(s) && s >= 0)
          || line.source_seconds[0] >= line.source_seconds[1] || line.source_seconds[1] > a!.source.duration_seconds
          || !labelTranslationsShape(line.labels_zh,line.labels)
          || (line.labels !== undefined && (!Array.isArray(line.labels) || !line.labels.every(text))))
          || new Set(lines.map((line) => line.id)).size !== lines.length) return { error: 'Copy lines require unique IDs, registered point_ids, in-range source_seconds, matching narration/captions and Chinese meaning' };
        const covered = new Set(lines.flatMap((line) => line.point_ids));
        if (registered.coverage.some((entry) => entry.treatment === 'explain' && !covered.has(entry.point_id))) return { error: 'New copy would remove a registered teaching point; nothing changed' };
        if (input.plan.selected_narration !== undefined && (!Array.isArray(input.plan.selected_narration)
          || input.plan.selected_narration.length !== lines.length
          || input.plan.selected_narration.some((line, i) => !object(line) || Object.keys(line).some((key) => !copyLineKeys.includes(key))
            || copyLineKeys.some((key) => JSON.stringify(line[key]) !== JSON.stringify(lines[i][key]))))) {
          return { error: 'Plan selected_narration must match the submitted copy lines; nothing changed' };
        }
        internal[input.candidate_id] = { status: 'candidate', review_status: 'pending', production_allowed: false,
          lines: structuredClone(lines), base_revision: a.revision, source_candidate_id: input.source_candidate_id };
        internal[input.plan_id] = { ...structuredClone(input.plan), status: 'candidate', review_status: 'pending', production_allowed: false,
          selected_narration: structuredClone(lines), script_candidate_id: input.candidate_id,
          source_binding: structuredClone(a.source), base_analysis_revision: a.revision };
        internal.current_script_candidate = input.candidate_id;
        internal.current_picture_plan = input.plan_id;
        review.internal_review = internal;
        unit.line_guidance = input.line_guidance;
        await invalidateChangedReviews(a);
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
          || !copyPreparationReady(doc)) return { error: 'Resolve source identity and breakdown before selecting copy' };
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
        if (!copyPreparationReady(doc)) return { error: 'Resolve source breakdown before saving a picture plan', breakdown_check: checkSourceBreakdown(doc) };
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
        const changes = selectedPointChanges(a.source_breakdown, args.record);
        a.source_breakdown = structuredClone(args.record);
        const check = checkSourceBreakdown({ ...doc, clipMentorAnalysis: a });
        // Incomplete coverage is saved as pending so the Agent can read and repair it; invalid references are not evidence.
        if (check.issues.some((i) => ['source_hash_missing_or_changed', 'segment_time_out_of_bounds', 'segment_evidence_kind_or_reference', 'segment_evidence_outside_range', 'point_segment_missing', 'unit_segment_missing', 'breakdown_unit_missing', 'coverage_point_missing', 'supporting_primary_missing', 'unrecognized_unit_field', 'original_playback_out_of_bounds', 'original_segment_outside_playback'].includes(i.code))) return { error: 'Resolve breakdown source/reference issues before saving', breakdown_check: check };
        for (const change of changes) a.audit.push({ revision: a.revision + 1, action: 'selected_point_changed',
          target_id: change.point_id, actor: args.actor, at: now, reason: JSON.stringify({ instruction_reason: args.reason, ...change }) });
        await invalidateChangedReviews(a);
      } else {
        if (args.action !== 'revise' || !(typeof args.collection === 'string' && ['evidence', 'points', 'blueprint', 'transcripts'].includes(args.collection))) return { error: 'Invalid revision collection/action' };
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
      a.audit.push({ revision: a.revision, action: name === 'review_clipmentor_analysis' ? String(args.state) : args.action === 'set_source_breakdown' ? 'set_source_breakdown' : args.action === 'set_picture_plan' ? 'set_picture_plan' : args.action === 'set_copy_candidate' ? 'set_copy_candidate' : 'revise',
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
    const pointerError = blueprintRevisionError(doc.clipMentorAnalysis?.blueprint ?? [], a.blueprint,args.action==='import'&&!doc.clipMentorAnalysis);
    if (pointerError) return { error: pointerError };
    const next = { ...doc, clipMentorAnalysis: a };
    const missingDelivery=missingDeliverySectionKinds(doc,next);
    if(missingDelivery.length)return{error:'delivery_sections_would_be_lost',missing_delivery_kinds:missingDelivery};
    try{deliverySectionsFromDoc(next);}
    catch(error){
      if(!(error instanceof Error)||!/^delivery_[a-z_]+(?::|$)/.test(error.message))throw error;
      return {error:error.message,next_step:'Fix the current delivery declaration before saving. Use section_id, kind, line, evidence_ids, picture and voice. picture must be a bound image, not a video source range. Move delivery lines out of the body candidate atomically with the new plan.'};
    }
    const handoff = await checkAnalysisHandoff(next);
    const breakdown = checkSourceBreakdown(next);
    const live = ctx.getDoc();
    if (!isCurrent(live)) return stale;
    const replacement = { ...live, clipMentorAnalysis: a };
    const expected = canonicalProjectJson(replacement);
    const unconfirmed = { error: 'Analysis write could not be confirmed; read again' };
    try {
      ctx.commands.applyDoc(replacement);
      if (!isCurrent(ctx.getDoc(), expected)) return unconfirmed;
    } catch { return unconfirmed; }
    return { ok: true, revision: a.revision, handoff, breakdown_check: breakdown, identity: 'local_declared_not_authenticated' };
  } catch (error) {
    if(error instanceof BlueprintImportError)return{error:error.code};
    // Only this static domain error is exposed; arbitrary input/errors remain redacted.
    if (error instanceof Error && error.message === OBSERVATION_ID_MISMATCH) return { error: OBSERVATION_ID_MISMATCH };
    return { error: 'Analysis input could not be validated; nothing changed' };
  }
}
