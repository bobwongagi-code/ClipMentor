import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkAnalysisHandoff, isClipMentorAnalysis } from './analysis';
import type { AnalysisActor } from './analysis';
import { importTeashellAnalysis } from './import-teashell';
import { executeTool, TOOL_SCHEMAS } from '../agent/tools';
import { activatedToolNamesForResult } from '../agent/skills/skill-tool-activation';
import { CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS } from '../agent/tools/schemas/clipmentor-analysis-tools';
import type { AgentContext } from '../agent/context';
import { makeDraft } from '../editor/store';
import type { ProjectDoc } from '../editor/types';
import { createProject, saveProject, loadProject, resetProjectStoreMemory, migrateProjectDoc } from '../persist/projectStore';
import { saveVersion, listVersions } from '../persist/versionStore';
import { importProjectPackage, buildProjectExport, PROJECT_EXPORT_FORMAT } from '../persist/projectTransfer';
import { putMediaBlob, resetMediaBlobMemory } from '../persist/mediaBlobStore';
import { isExternalDraftTool, isExternalReadTool } from '../agent/external-tool-policy';
import { policyForTool, assertValidAgentToolSchemas } from '../agent/execution-policy';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/teashell-historical.json', import.meta.url), 'utf8'));
const actor: AnalysisActor = { operator: 'test-operator', executor: 'verification',
  instruction: 'Test-only explicit confirmation; not a production human review', identity: 'local_declared_not_authenticated' };
const assetId = '12546aa7-70fd-42c1-852a-8bf50f2abf58';
const analysis = importTeashellAnalysis(fixture, assetId, actor, 1);
assert(isClipMentorAnalysis(analysis));
const enumAnalysis = structuredClone(analysis);
enumAnalysis.observations = [{ observation_id: 'test-observation', source_hash: analysis.source.sourceContentHash!, requested_times_seconds: [60],
  frame_evidence_ids: [], status: 'images_returned', sampling: 'sequence', method: 'source_frames_for_main_agent', at: 1 }];
enumAnalysis.reviews = [{ point_id: analysis.points[0].point_id, state: 'confirmed', source_hash: analysis.source.sourceContentHash,
  content_digest: 'a'.repeat(64), actor, at: 1, reason: 'Synthetic structural check only' }];
assert(isClipMentorAnalysis(enumAnalysis));
for (const [collection, index, field, allowed] of [
  ['observations', 0, 'status', ['images_returned', 'failed']],
  ['observations', 0, 'sampling', ['explicit_times', 'sequence']],
  ['evidence', analysis.evidence.findIndex(e => e.kind === 'source_frame'), 'kind', ['source_frame']],
  ['evidence', 0, 'call_status', ['historical_unknown', 'unknown', 'failed', 'succeeded']],
  ['reviews', 0, 'state', ['confirmed', 'needs_revision', 'stale']],
] as const) {
  for (const scalar of allowed) {
    const valid = structuredClone(enumAnalysis); Object.assign(valid[collection]![index], { [field]: scalar });
    assert(isClipMentorAnalysis(valid), `valid ${collection}.${field}:${scalar}`);
    for (const value of [[scalar], [[scalar]], null, {}, true, 0]) {
      const invalid = structuredClone(valid); Object.assign(invalid[collection]![index], { [field]: value });
      assert(!isClipMentorAnalysis(invalid), `reject non-string ${collection}.${field}`);
    }
  }
}

assert.equal(analysis.points.length, 6);
assert.equal(analysis.transcripts[0].words.length, 362);
assert.equal(analysis.evidence.find((e) => e.evidence_id === 'TS-A04')?.status, 'uncertain');
assert.equal(analysis.evidence.find((e) => e.evidence_id === 'TS-U01')?.provenance, 'user_feedback_in_current_conversation');
assert.equal(analysis.reviews.length, 0);
assert(analysis.evidence.filter((e) => e.kind === 'source_frame').every((e) => e.call_status === 'historical_unknown'));
assert(!JSON.stringify(fixture).includes('/Users/'));
const base: ProjectDoc = {
  version: 3, assets: [{ id: assetId, name: 'source', kind: 'video', src: '/media/uploads/test.mp4',
    sourceContentHash: analysis.source.sourceContentHash!, durationInFrames: 2996 }], mediaFolders: [],
  timelines: [{ id: 'tl', name: 'Test', order: 0, fps: 30, width: 576, height: 1024,
    items: [], selectedId: null, tracks: { track_v1: { kind: 'video' } }, trackOrder: ['track_v1'] }], activeTimelineId: 'tl',
};
const engine = makeDraft(migrateProjectDoc(base)!);
const ctx: AgentContext = { commands: engine.commands, getDoc: engine.getDoc, getState: engine.getState,
  getCreativeMode: () => null, templates: [], audio: [] };
async function call(name: string, args: Record<string, unknown>) {
  return await executeTool(name, args, ctx) as { ok?: boolean; error?: string; revision?: number };
}
assertValidAgentToolSchemas(CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS);
const serverCatalog = JSON.parse(readFileSync(new URL('../../assets/agent/openchatcut-tool-schemas.json', import.meta.url), 'utf8'));
for (const tool of CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS) {
  const generated = serverCatalog.edit.find((entry: { name: string }) => entry.name === tool.name);
  assert(generated, 'server catalog must include the analysis tool');
  assert.deepEqual(generated.input_schema, tool.input_schema, 'server catalog must match the current analysis schema');
}

const skillBody = readFileSync(new URL('../agent/skills/clipmentor/SKILL.md', import.meta.url), 'utf8');
const activated = activatedToolNamesForResult('load_skill', { contents: { 'SKILL.md': skillBody } }, TOOL_SCHEMAS);
for (const tool of CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS) {
  assert(TOOL_SCHEMAS.some((t) => t.name === tool.name), 'tool registered in the actual Agent catalog');
  assert(activated.includes(tool.name), 'loading the bundled skill activates the analysis tool');
}
const browserOnlyPreviewTools = new Set(['edit_clipmentor_preview', 'review_clipmentor_preview']);
for (const tool of CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS) assert.equal(isExternalDraftTool(tool.name), !browserOnlyPreviewTools.has(tool.name),
  'preview host routes are not generic external draft tools; keep their explicit permit/call boundaries');
assert.equal(policyForTool('transcribe_clipmentor_source').effect, 'irreversible_external');
assert(isExternalReadTool('read_clipmentor_analysis'));
assert.equal(policyForTool('read_clipmentor_analysis').effect, 'read');
assert.equal(policyForTool('revise_clipmentor_analysis').effect, 'reversible_edit');
assert.equal(policyForTool('review_clipmentor_analysis').effect, 'reversible_edit');
const importArgs = { action: 'import', fixture: 'teashell_historical_v1', assetId, actor, reason: 'test historical import', expectedRevision: 0 };
assert((await call('revise_clipmentor_analysis', importArgs)).ok);
const beforeInvalidEnum = JSON.stringify(engine.getDoc());
for (const [name, args] of [
  ['read_clipmentor_analysis', { view: ['full'] }],
  ['read_clipmentor_analysis', { view: 'copy_review', reviewPart: ['result'] }],
  ['review_clipmentor_analysis', { state: ['confirmed'], pointId: 'TS-CMP-01' }],
  ['revise_clipmentor_analysis', { action: 'revise', collection: ['points'], id: 'TS-CMP-01', record: analysis.points[0] }],
] as const) {
  assert((await call(name, { ...args, actor, reason: 'Invalid enum test', expectedRevision: engine.getDoc().clipMentorAnalysis!.revision })).error);
  assert.equal(JSON.stringify(engine.getDoc()), beforeInvalidEnum, 'invalid tool enums never write');
}

assert((await call('revise_clipmentor_analysis', importArgs)).error, 'stale write rejected');
assert.equal((await checkAnalysisHandoff(engine.getDoc())).status, 'review_required');
const originalTimeline = JSON.stringify(engine.getDoc().timelines);
const historicalImported = structuredClone(engine.getDoc());
assert((await checkAnalysisHandoff(historicalImported)).issues.some((i) => i.code === 'source_time_out_of_bounds'));
// The ASR reports 99.870s for a 99.8667s source. Preserve the real fixture;
// only explicit operator revisions of the TEST copy resolve that edge for the positive review case.
const beforeCorrection = JSON.stringify(engine.getDoc());
for (const wordIndex of [-1, 99999]) {
  assert((await call('revise_clipmentor_analysis', { action: 'revise', collection: 'transcripts', id: 'TS-ASR-FULL',
    wordIndex, endSeconds: analysis.source.duration_seconds, actor, reason: 'invalid index test',
    expectedRevision: engine.getDoc().clipMentorAnalysis!.revision })).error);
  assert.equal(JSON.stringify(engine.getDoc()), beforeCorrection);
}
for (const invalidPatch of [
  { wordIndex: 361, endSeconds: analysis.source.duration_seconds + 1 },
  { wordIndex: 361, endSeconds: 98 },
  { wordIndex: 361, endSeconds: Number.NaN },
  { wordIndex: 361, endSeconds: analysis.source.duration_seconds, record: {} },
  { wordIndex: 0, endSeconds: 1, collection: 'points', id: 'TS-CMP-01' },
]) {
  assert((await call('revise_clipmentor_analysis', { action: 'revise', collection: 'transcripts', id: 'TS-ASR-FULL',
    actor, reason: 'invalid endpoint patch test', expectedRevision: engine.getDoc().clipMentorAnalysis!.revision,
    ...invalidPatch })).error);
  assert.equal(JSON.stringify(engine.getDoc()), beforeCorrection, 'invalid patches never mutate source records');
}
for (const original of historicalImported.clipMentorAnalysis!.transcripts) {
  assert((await call('revise_clipmentor_analysis', { action: 'revise', collection: 'transcripts', id: original.source_id,
    wordIndex: original.words.length - 1, endSeconds: analysis.source.duration_seconds,
    actor, reason: 'Test-only explicit ASR endpoint correction; original historical fixture unchanged',
    expectedRevision: engine.getDoc().clipMentorAnalysis!.revision })).ok);
  const current = engine.getDoc().clipMentorAnalysis!.transcripts.find((t) => t.source_id === original.source_id)!;
  assert.deepEqual(current.words.slice(0, -1), original.words.slice(0, -1));
  assert.deepEqual(current.words.at(-1), { ...original.words.at(-1), end_seconds: analysis.source.duration_seconds });
}
for (const point of analysis.points) {
  const revision = engine.getDoc().clipMentorAnalysis!.revision;
  assert((await call('review_clipmentor_analysis', { pointId: point.point_id, state: 'confirmed', actor, reason: 'test fixture reviewed', expectedRevision: revision })).ok);
}
const approved = structuredClone(engine.getDoc());
assert.equal((await checkAnalysisHandoff(approved)).status, 'ready_for_copy_review');
assert.equal(approved.clipMentorAnalysis!.evidence.find((e) => e.evidence_id === 'TS-A04')?.status, 'uncertain', 'point review never upgrades transcript listening status');
const originalAnalysis = JSON.stringify(engine.getDoc());
assert((await call('review_clipmentor_analysis', { pointId: analysis.points[0].point_id, state: 'confirmed', actor: {}, reason: 'bad actor', expectedRevision: engine.getDoc().clipMentorAnalysis!.revision })).error);
assert.equal(JSON.stringify(engine.getDoc()), originalAnalysis);
const point = structuredClone(engine.getDoc().clipMentorAnalysis!.points[0]);
point.filming_conditions.push('test revised condition');
assert((await call('revise_clipmentor_analysis', { action: 'revise', collection: 'points', id: point.point_id, record: point,
  actor, reason: 'test condition edit', expectedRevision: engine.getDoc().clipMentorAnalysis!.revision })).ok);
assert.equal((await checkAnalysisHandoff(engine.getDoc())).point_states[0].state, 'stale');
assert.equal(JSON.stringify(engine.getDoc().timelines), originalTimeline);
assert.deepEqual(engine.getDoc().assets, approved.assets);
assert.equal(engine.getDoc().clipMentorAnalysis!.audit.at(-1)?.actor.operator, actor.operator);
const invalid = structuredClone(approved) as unknown as Record<string, unknown>;
invalid.clipMentorAnalysis = { schema_version: 1 };
assert.equal(migrateProjectDoc(invalid), null, 'malformed analysis is rejected, not silently discarded');
assert(migrateProjectDoc(base), 'ordinary projects remain readable');
for (const edit of [
  (a: typeof analysis) => { a.points[0].evidence_ids.push('missing'); },
  (a: typeof analysis) => { a.points[0].source_range_seconds[1] = 1000; },
  (a: typeof analysis) => { a.blueprint[0].point_ids = []; },
  (a: typeof analysis) => { a.evidence.find((e) => e.kind === 'visible_action')!.supporting_evidence_ids = []; },
  (a: typeof analysis) => { a.evidence.find((e) => e.kind === 'source_frame')!.time_seconds = 999; },
  (a: typeof analysis) => { a.transcripts[0].words[0].text = 'changed'; },
]) {
  const d = structuredClone(approved); edit(d.clipMentorAnalysis!);
  assert.equal((await checkAnalysisHandoff(d)).status, 'review_required');
}
const changed = structuredClone(approved); changed.assets[0].sourceContentHash = 'a'.repeat(64);
assert((await checkAnalysisHandoff(changed)).point_states.every((p) => p.state === 'stale'));
const missing = structuredClone(approved); delete missing.assets[0].sourceContentHash;
assert.equal((await checkAnalysisHandoff(missing)).status, 'review_required');
const renamed = structuredClone(approved); renamed.assets[0].name = 'renamed';
assert.equal((await checkAnalysisHandoff(renamed)).status, 'ready_for_copy_review');

// Persistent project boundaries: real store/migrations/version/transfer paths, no network model calls.
resetProjectStoreMemory(); resetMediaBlobMemory();
const historical = await createProject('Historical import verification', historicalImported);
assert.deepEqual((await loadProject(historical.id))?.clipMentorAnalysis, historicalImported.clipMentorAnalysis, 'real historical records roundtrip unchanged');
const meta = await createProject('Analysis verification', approved);
await saveProject(meta.id, engine.getDoc());
assert.deepEqual((await loadProject(meta.id))?.clipMentorAnalysis, engine.getDoc().clipMentorAnalysis);
await saveVersion(meta.id, 'Approved analysis', approved);
const restored = (await listVersions(meta.id))[0].doc;
assert.deepEqual(restored.clipMentorAnalysis, approved.clipMentorAnalysis);
assert.equal((await checkAnalysisHandoff(restored)).status, 'ready_for_copy_review');
restored.assets[0].sourceContentHash = 'b'.repeat(64);
assert.equal((await checkAnalysisHandoff(restored)).status, 'review_required');

// Portable fixtures use small synthetic bytes; they test transfer integrity, not video quality.
const transfer = structuredClone(approved);
// New selected-task ledger travels with the project, not a workstation Markdown path.
const selected = transfer.clipMentorAnalysis!.points[0];
transfer.clipMentorAnalysis!.source_breakdown = {
  version: 1, segments: [{ segment_id: 'historical-window', source_range_seconds: selected.source_range_seconds,
    visible_evidence_ids: [`${selected.point_id}:visible`], claim_evidence_ids: [],
    interpretation_evidence_ids: [`${selected.point_id}:interpretation`], unknowns: selected.uncertainties }],
  points: [{ point_id: selected.point_id, segment_ids: ['historical-window'], buying_concern: selected.buying_reason_or_function,
    teaching_question: 'What can a creator learn from this demonstrated method?', filming_conditions: selected.filming_conditions,
    role: 'primary', importance: 'must_explain' }],
  units: [{ unit_id: selected.unit_id, original_segment_ids: ['historical-window'], explanation_segment_ids: ['historical-window'],
    coverage: [{ point_id: selected.point_id, treatment: 'explain' }], revisits: [{ from_segment_id: 'historical-window', to_segment_id: 'historical-window', reason: 'Explain the selected source method' }] }],
};
const media = 'synthetic-transfer-fixture';
const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(media));
const mediaHash = [...new Uint8Array(hashBytes)].map((v) => v.toString(16).padStart(2, '0')).join('');
transfer.assets[0].sourceContentHash = mediaHash;
transfer.clipMentorAnalysis!.source.sourceContentHash = mediaHash;
transfer.clipMentorAnalysis!.reviews = []; // new source fixture cannot inherit Teashell approvals
const fetchBefore = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = async (input) => {
  // In-memory local media authority; no actual network or model service.
  if (String(input).startsWith('/media/uploads/')) return new Response(media, { headers: { 'content-type': 'video/mp4' } });
  externalCalls++; throw new Error(`Unexpected network in data test: ${String(input).split('?')[0]}`);
};
try {
  await putMediaBlob(transfer.assets[0].src, new Blob([media], { type: 'video/mp4' }));
  const project = await createProject('Transfer analysis', transfer);
  await saveProject(project.id, transfer);
  assert.deepEqual((await loadProject(project.id))?.clipMentorAnalysis?.source_breakdown, transfer.clipMentorAnalysis!.source_breakdown, 'breakdown ledger survives save/reopen');
  await saveVersion(project.id, 'Breakdown ledger', transfer);
  assert.deepEqual((await listVersions(project.id))[0].doc.clipMentorAnalysis?.source_breakdown, transfer.clipMentorAnalysis!.source_breakdown, 'version restore retains the ledger');
  const output = await buildProjectExport(project.id, 'Transfer analysis');
  let importedDoc: ProjectDoc | undefined;
  const options = { publish: async (staged: { doc: ProjectDoc }) => {
    importedDoc = staged.doc; return { id: 'roundtrip', name: 'roundtrip', updatedAt: 1 };
  } };
  await importProjectPackage(output.blob, options);
  assert.deepEqual(importedDoc?.clipMentorAnalysis, transfer.clipMentorAnalysis, 'stream export/import retains all analysis IDs and statuses');
  const legacy = new Blob([JSON.stringify({ format: PROJECT_EXPORT_FORMAT, name: 'Legacy', exportedAt: new Date(0).toISOString(),
    doc: transfer, media: [{ src: transfer.assets[0].src, name: 'test.mp4', mime: 'video/mp4', bytes: media.length, dataBase64: btoa(media) }] })]);
  await importProjectPackage(legacy, options);
  assert.deepEqual(importedDoc?.clipMentorAnalysis, transfer.clipMentorAnalysis, 'legacy import retains all analysis IDs and statuses');
} finally { globalThis.fetch = fetchBefore; }
assert.equal(externalCalls, 0, 'no ASR, vision, TTS, or Flayr calls');
console.log('ClipMentor analysis: schema, provenance, tools, invalidation, store, versions and both transfer formats passed');
