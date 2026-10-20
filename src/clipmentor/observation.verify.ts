import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AgentContext } from '../agent/context';
import { executeTool } from '../agent/tools';
import { makeDraft } from '../editor/store';
import { createProject, saveProject, loadProject, migrateProjectDoc } from '../persist/projectStore';
import { saveVersion, listVersions } from '../persist/versionStore';
import { importTeashellAnalysis } from './import-teashell';
import { isClipMentorAnalysis, checkAnalysisHandoff, type AnalysisActor } from './analysis';
import { policyForTool } from '../agent/execution-policy';
import { isExternalDraftTool } from '../agent/external-tool-policy';

const actor: AnalysisActor = { operator: 'test-only', executor: 'verifier', instruction: 'test candidate analysis, no approvals', identity: 'local_declared_not_authenticated' };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/teashell-historical.json', import.meta.url), 'utf8'));
const a = importTeashellAnalysis(fixture, 'source', actor, 1);
a.evidence = []; a.points = []; a.blueprint = []; a.reviews = [];
const engine = makeDraft({ version: 3, assets: [{ id: 'source', name: 'Original', kind: 'video', src: '/media/uploads/source.mp4',
  durationInFrames: 2996, sourceContentHash: a.source.sourceContentHash! }], mediaFolders: [],
  timelines: [{ id: 't', name: 'Untouched', order: 0, fps: 30, width: 576, height: 1024, items: [], selectedId: null, tracks: {}, trackOrder: [] }],
  activeTimelineId: 't', clipMentorAnalysis: a });
const ctx: AgentContext = { getDoc: engine.getDoc, getState: engine.getState, commands: engine.commands,
  templates: [], audio: [], getCreativeMode: () => null };
const beforeMedia = JSON.stringify(engine.getDoc().assets);
const beforeTimeline = JSON.stringify(engine.getDoc().timelines);
const rawTranscripts = structuredClone(a.transcripts);
const fetchBefore = globalThis.fetch;
let mode: 'success' | 'partial' | 'reordered' | 'wrong-time' | 'failure' | 'concurrent' = 'success';
let requests = 0;
let lastTimes: number[] = [];
globalThis.fetch = async (url, init) => {
  assert.equal(url, '/api/extract-frames', 'never call recognition or a separate model');
  requests++;
  const body = JSON.parse(String(init?.body));
  assert.equal(body.output, 'frames');
  const times: number[] = body.sourceTimesMs;
  lastTimes = times;
  if (mode === 'failure') throw new Error('sensitive-provider-error-not-to-expose');
  if (mode === 'concurrent') engine.commands.applyDoc({ ...engine.getDoc(), activeTimelineId: 'changed' });
  const returned = mode === 'partial' ? times.slice(0, 1) : mode === 'reordered' ? [...times].reverse() : times;
  return new Response(JSON.stringify({ output: 'frames', sampleCount: returned.length, sourceTimesMs: returned,
    frames: returned.map((t) => ({ base64: 'dGVzdC1mcmFtZS1pbWFnZQ==', sourceTimeMs: mode === 'wrong-time' ? t + 1 : t, mediaType: 'image/jpeg' })) }), { status: 200 });
};
const call = async (name: string, args: Record<string, unknown>) => await executeTool(name,
  { actor, reason: 'verification only', expectedRevision: engine.getDoc().clipMentorAnalysis!.revision, ...args }, ctx) as Record<string, any>;
try {
  assert(isExternalDraftTool('observe_clipmentor_source'));
  assert.equal(policyForTool('observe_clipmentor_source').effect, 'reversible_edit');
  const unchanged = JSON.stringify(engine.getDoc());
  for (const seconds of [[], [-1], [1000], Array(9).fill(1)]) assert((await call('observe_clipmentor_source', { seconds })).error);
  assert.equal(requests, 0); assert.equal(JSON.stringify(engine.getDoc()), unchanged);
  const result = await call('observe_clipmentor_source', { seconds: [10, 11.1] });
  assert(result.ok && result.__images.length === 2);
  assert.deepEqual(result.__images.map((f: { frame: number }) => f.frame), [300, 333]);
  assert(result.note.includes('Image 2:') && result.note.includes('11.1s'), 'Codex note preserves image/time/ID mapping');
  assert.equal(result.interpretationVerified, false);
  const o = result.observation;
  assert.equal(o.status, 'images_returned');
  assert.equal(o.image_layout, 'individual_frames');
  assert.equal(o.sampling, 'explicit_times');
  assert.deepEqual(o.requested_times_seconds, [10, 11.1]);
  assert.equal(o.frame_evidence_ids.length, 2);
  assert(!JSON.stringify(engine.getDoc()).includes('test-frame-image'), 'image bytes never persisted in ProjectDoc');
  assert(!JSON.stringify(engine.getDoc()).includes('dGVzdC1mcmFtZS1pbWFnZQ=='));
  assert(engine.getDoc().clipMentorAnalysis!.evidence.every((e) => e.status === 'frame_extracted_not_interpreted'));
  const visual = { evidence_id: 'V1', kind: 'visible_action', text: 'Synthetic test action, not real video evidence',
    status: 'agent_observed_candidate', source_range_seconds: [10, 12], supporting_evidence_ids: o.frame_evidence_ids,
    source_ids: [], observation_id: o.observation_id, observation_method: 'main_agent_direct_image_read_not_independently_verified', call_status: 'unknown' };
  const interpretation = { evidence_id: 'I1', kind: 'expression_analysis_not_verified_causal_effect', text: 'Synthetic expression analysis; not a verified efficacy claim',
    status: 'inferred_not_verified_causal_effect', source_range_seconds: [10, 12], supporting_evidence_ids: ['V1'], source_ids: [] };
  const point = { point_id: 'P1', unit_id: 'U1', source_range_seconds: [10, 12], buying_reason_or_function: 'Test buying reason/filming relationship',
    filming_conditions: ['test necessary condition'], evidence_ids: ['V1', 'I1'], uncertainties: ['source speech unknown'],
    required: true, explanation_priority: 'test', status: 'candidate', review_status: 'pending', provenance: 'test-only' };
  const records = { product: { name: 'Test product', category: 'test' }, evidence: [visual, interpretation], points: [point],
    blueprint: [{ unit_id: 'U1', point_ids: ['P1'], intent_zh: 'Test intent', line_guidance: 'No final copy' }] };
  for (const bad of [
    { evidence: [{ ...visual, supporting_evidence_ids: ['missing'] }] },
    { evidence: [{ ...visual, observation_id: 'invented' }] },
    { evidence: [{ ...visual, status: 'verified' }] },
    { evidence: [{ ...interpretation, supporting_evidence_ids: [] }] },
    { evidence: [{ ...visual, source_range_seconds: [10, 200] }] },
    { points: [{ ...point, review_status: 'confirmed' }] },
    { evidence: [engine.getDoc().clipMentorAnalysis!.evidence[0]] },
    { transcripts: [{ ...a.transcripts[0], status: 'listening_verified' }] },
    { reviews: [] },
  ]) {
    const prior = JSON.stringify(engine.getDoc());
    assert((await call('revise_clipmentor_analysis', { action: 'append', records: bad })).error);
    assert.equal(JSON.stringify(engine.getDoc()), prior, 'rejected findings never mutate records');
  }
  const beforeIdError = JSON.stringify(engine.getDoc());
  const idError = await call('revise_clipmentor_analysis', { action: 'append', records: { evidence: [{ ...visual, observation_id: o.observation_id.replace(/^observation:/, '') }] } });
  assert.match(idError.error, /observation_id.*exactly match/, 'a stripped observation prefix must identify the actual bad field, not a generic validation error');
  assert.equal(JSON.stringify(engine.getDoc()), beforeIdError);
  assert((await call('revise_clipmentor_analysis', { action: 'append', records })).ok);
  assert.deepEqual(engine.getDoc().clipMentorAnalysis!.transcripts, rawTranscripts, 'unknown and out-of-bounds old ASR preserved');
  assert.equal(engine.getDoc().clipMentorAnalysis!.reviews.length, 0);
  const handoff = await checkAnalysisHandoff(engine.getDoc());
  assert.equal(handoff.status, 'review_required');
  assert.equal(handoff.point_states[0].state, 'pending');
  assert((await call('revise_clipmentor_analysis', { action: 'append', records })).error, 'no duplicate IDs or overwrite');
  assert((await call('revise_clipmentor_analysis', { action: 'append', records: { evidence: [
    { ...visual, evidence_id: 'V-INSTANT', source_range_seconds: [10, 10], supporting_evidence_ids: [o.frame_evidence_ids[0]] },
  ] } })).ok, 'a directly observed single-frame pose has an instant, not an invented duration');
  const instant = engine.getDoc().clipMentorAnalysis!.evidence.find((e) => e.evidence_id === 'V-INSTANT');
  assert.deepEqual(instant?.source_range_seconds, [10, 10], 'no automatic range expansion');
  assert((await call('revise_clipmentor_analysis', { action: 'append', records: { points: [
    { ...point, point_id: 'P-ZERO', unit_id: 'U-ZERO', source_range_seconds: [10, 10] },
  ] } })).error, 'blueprint points still need a meaningful interval');
  const beforeInvalidSequence = requests;
  for (const input of [
    {}, { seconds: [1], sequence: { startSeconds: 1, endSeconds: 2, count: 3 } },
    ...[
      { startSeconds: -1, endSeconds: 2, count: 3 }, { startSeconds: 2, endSeconds: 1, count: 3 },
      { startSeconds: 1, endSeconds: 200, count: 3 }, { startSeconds: 1, endSeconds: 2, count: 9 },
      { startSeconds: 1, endSeconds: 2, count: 1 }, { startSeconds: 1, endSeconds: 1.001, count: 8 },
    ].map((sequence) => ({ sequence })),
  ]) assert((await call('observe_clipmentor_source', input)).error);
  assert.equal(requests, beforeInvalidSequence, 'invalid/duplicate-frame windows never extract');
  const sequence = await call('observe_clipmentor_source', { sequence: { startSeconds: 12, endSeconds: 13, count: 5 } });
  assert(sequence.ok && sequence.__images.length === 5);
  assert.equal(sequence.observation.sampling, 'sequence');
  assert.deepEqual(sequence.__images.map((f: { frame: number }) => f.frame), [360, 367, 375, 382, 390]);
  assert.deepEqual(lastTimes, [12000, 12233, 12500, 12733, 13000]);
  for (const mismatch of ['reordered', 'wrong-time'] as const) {
    mode = mismatch;
    const bad = await call('observe_clipmentor_source', { seconds: [15, 16] });
    assert.equal(bad.observation.status, 'failed'); assert(!bad.__images);
    assert.deepEqual(bad.observation.frame_evidence_ids, []);
  }
  mode = 'partial';
  const partial = await call('observe_clipmentor_source', { seconds: [20, 21] });
  assert.equal(partial.ok, false);
  assert.equal(partial.observation.status, 'failed');
  assert.equal(partial.observation.frame_evidence_ids.length, 0, 'partial sheets cannot bind wrong times to cells');
  assert(!partial.__images);
  mode = 'failure';
  const failed = await call('observe_clipmentor_source', { seconds: [30] });
  assert.equal(failed.observation.status, 'failed');
  assert(!JSON.stringify(failed).includes('sensitive-provider-error'));
  assert((await checkAnalysisHandoff(engine.getDoc())).issues.some((i) => i.code === 'failed_observation'));
  assert.equal(JSON.stringify(engine.getDoc().assets), beforeMedia);
  assert.equal(JSON.stringify(engine.getDoc().timelines), beforeTimeline);
  assert(isClipMentorAnalysis(engine.getDoc().clipMentorAnalysis));
  assert.deepEqual(migrateProjectDoc(engine.getDoc())?.clipMentorAnalysis, engine.getDoc().clipMentorAnalysis);
  const meta = await createProject('Observation verification', engine.getDoc());
  await saveProject(meta.id, engine.getDoc());
  assert.deepEqual((await loadProject(meta.id))?.clipMentorAnalysis, engine.getDoc().clipMentorAnalysis);
  await saveVersion(meta.id, 'Candidate observations', engine.getDoc());
  assert.deepEqual((await listVersions(meta.id))[0].doc.clipMentorAnalysis, engine.getDoc().clipMentorAnalysis);
  const changed = structuredClone(engine.getDoc()); changed.assets[0].sourceContentHash = 'a'.repeat(64); engine.commands.applyDoc(changed);
  const count = requests;
  assert((await call('observe_clipmentor_source', { seconds: [1] })).error);
  assert((await call('revise_clipmentor_analysis', { action: 'append', records: { product: { name: 'x', category: '' } } })).error);
  assert.equal(requests, count, 'changed source blocks before extraction');
  changed.assets[0].sourceContentHash = a.source.sourceContentHash!; engine.commands.applyDoc(changed);
  mode = 'concurrent';
  const rev = engine.getDoc().clipMentorAnalysis!.revision;
  assert((await call('observe_clipmentor_source', { seconds: [2] })).error);
  assert.equal(engine.getDoc().clipMentorAnalysis!.revision, rev, 'no stale asynchronous write');
} finally { globalThis.fetch = fetchBefore; }
console.log('clipmentor observation: extraction/failure provenance, candidate-only append, unknown speech, references, source binding, persistence and unchanged timeline passed');
