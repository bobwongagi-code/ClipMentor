import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ProjectDoc } from '../../src/editor/types';
import { diffDeliveryCheck } from '../../src/clipmentor/delivery-diff';

globalThis.fetch = (async () => { throw new Error('No network allowed'); }) as typeof fetch;
const base: ProjectDoc = { version: 3, assets: [], mediaFolders: [], activeTimelineId: 'T',
  timelines: [{ id: 'T', name: 'test', order: 0, fps: 30, width: 576, height: 1024, items: [], selectedId: null }] };
const next = structuredClone(base);
next.assets.push({ id: 'new-audio', name: 'synthetic', src: '/mock.mp3', kind: 'audio', durationInFrames: 30 });
next.timelines[0].items.push({ id: 'clip', kind: 'video', name: 'mock', src: '/mock.mp4', track: 'v', startFrame: 0, durationInFrames: 30 });
const frozen = JSON.stringify([base, next]);
const delta = await diffDeliveryCheck(base, next);
assert.equal(delta.added_audio_assets, 1);
assert(delta.changes.some(c => c.scope === 'asset' && c.change === 'added'));
assert(delta.changes.some(c => c.scope === 'timeline' && c.fields.includes('items')));
assert.equal(JSON.stringify([base, next]), frozen);
assert.deepEqual((await diffDeliveryCheck(base, structuredClone(base))).changes, []);
assert.equal(delta.to_gate.allowed, false, 'a difference report never grants approval');
const dir = await mkdtemp(join(tmpdir(), 'delivery-diff-'));
const command = fileURLToPath(new URL('./delivery-diff.mts', import.meta.url));
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const run = (...args: string[]) => execFileSync(process.execPath, [tsx, command, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const old = join(dir, 'before.json'), fresh = join(dir, 'after.json');
  await writeFile(old, JSON.stringify(base)); await writeFile(fresh, JSON.stringify(next));
  assert(run('--help').includes('Read-only'));
  assert(run(old, fresh).includes('1 added audio assets'));
  assert.equal(JSON.parse(run(old, fresh, '--json')).added_audio_assets, 1);
  assert(run(old, old).includes('unchanged records omitted'));
  assert.throws(() => run('revision168', 'revision169'));
  assert.throws(() => run(old, fresh, '--unknown'));
  const invalid = join(dir, 'invalid.json'); await writeFile(invalid, 'PRIVATE_NOT_JSON');
  try { run(old, invalid); assert.fail('invalid JSON must fail'); }
  catch (e) { if (e instanceof assert.AssertionError) throw e; assert(!String((e as any).stderr).includes('PRIVATE_NOT_JSON')); }
  assert.equal(await readFile(old, 'utf8'), JSON.stringify(base));
  assert.equal(await readFile(fresh, 'utf8'), JSON.stringify(next));
  const control = structuredClone(next);
  Object.assign(control.assets[0], { ['\u001b[31m']: 'untrusted field' });
  const existing = join(dir, 'existing.json'); await writeFile(existing, JSON.stringify(next));
  await writeFile(fresh, JSON.stringify(control));
  const printed = run(existing, fresh);
  assert(printed.includes('\\u001b[31m'), 'the changed field must actually reach the output');
  assert(!printed.includes('\u001b'), 'human output cannot execute control characters from snapshot fields');
  await writeFile(fresh, JSON.stringify(next));
  const fixture: any = structuredClone(base);
  fixture.clipMentorAnalysis = { schema_version: 1, analysis_id: 'test', revision: 1,
    source: { asset_id: 'V', sourceContentHash: null, duration_seconds: 30, fps: 30 }, product: { name: 'test', category: 'test' },
    import_origin: 'test', evidence: [], points: [], transcripts: [], reviews: [], audit: [],
    blueprint: [{ unit_id: 'U', point_ids: [], intent_zh: 'wet skin', line_guidance: '', narration_budget_seconds: [1, 2] }] };
  const changed = structuredClone(fixture);
  changed.clipMentorAnalysis.blueprint[0].intent_zh = 'washed skin';
  changed.clipMentorAnalysis.blueprint[0].narration_budget_seconds = [10, 20];
  assert.deepEqual((await diffDeliveryCheck(fixture, changed)).changes.find(c => c.scope === 'current_unit')?.fields,
    ['intent_zh', 'narration_budget_seconds']);
  fixture.clipMentorAnalysis.production_copy_review = { scope: 'copy_and_planned_picture_only', protocol: 'creator-copy-v1',
    analysis_revision: 1, content_digest: 'a'.repeat(64), author_run_id: 'author', reviewer_run_id: 'reviewer', reviewed_at: 1, verdict: 'pass', units: [] };
  const reviewChanged = structuredClone(fixture);
  reviewChanged.clipMentorAnalysis.production_copy_review.verdict = 'needs_revision';
  reviewChanged.clipMentorAnalysis.production_copy_review.reviewer_run_id = 'other';
  assert((await diffDeliveryCheck(fixture, reviewChanged)).changes.some(c => c.scope === 'review_receipt' && c.fields.includes('verdict') && c.fields.includes('reviewer_run_id')));
  const legacy = structuredClone(base);
  legacy.timelines.push({ ...structuredClone(base.timelines[0]), id: 'T2' });
  legacy.assets.push({ id: 'legacy', kind: 'video', name: 'legacy', src: '/legacy.mp4', durationInFrames: 30,
    transcript: [{ text: 'hello', start: 0, end: 100 }] } as any);
  const noAssets: any = structuredClone(base); delete noAssets.assets;
  await writeFile(old, JSON.stringify(noAssets)); await writeFile(fresh, JSON.stringify(base));
  assert.deepEqual(JSON.parse(run(old, fresh, '--json')).changes, [], 'legacy missing asset list means an empty persisted list');
  const activeChanged = structuredClone(legacy); activeChanged.activeTimelineId = 'T2';
  await writeFile(old, JSON.stringify(legacy)); await writeFile(fresh, JSON.stringify(activeChanged));
  const legacyDelta = JSON.parse(run(old, fresh, '--json'));
  assert(legacyDelta.active_timeline_changed);
  assert(!legacyDelta.changes.some((c: any) => c.scope === 'asset'), 'migration-generated transcript IDs are not source snapshot edits');
  const domainBase = structuredClone(fixture);
  delete domainBase.clipMentorAnalysis.production_copy_review;
  domainBase.clipMentorAnalysis.points = [{ point_id: 'P', unit_id: 'U', source_range_seconds: [1, 2], buying_reason_or_function: 'use',
    filming_conditions: [], evidence_ids: [], uncertainties: [], required: true, explanation_priority: 'primary', status: 'candidate', review_status: 'pending', provenance: 'synthetic' }];
  domainBase.clipMentorAnalysis.reviews = [{ point_id: 'P', state: 'confirmed', content_digest: 'a'.repeat(64), source_hash: null,
    actor: { operator: 'test', executor: 'test', instruction: 'test', identity: 'local_declared_not_authenticated' }, at: 1, reason: 'synthetic' }];
  domainBase.clipMentorAnalysis.transcripts = [{ source_id: 'ASR', provider: 'test', origin: 'synthetic', status: 'pending', words: [{ start_seconds: 1, end_seconds: 2, text: 'hello' }] }];
  domainBase.clipMentorAnalysis.observations = [];
  domainBase.clipMentorAnalysis.source_transcription = { schema_version: 1, operation_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', provider: 'fun-asr',
    model: 'fun-asr-flash-2026-06-15', requested_language: 'auto', detected_language: null, source_hash: 'a'.repeat(64), duration_seconds: 30, fps: 30,
    audio: { format: 'mp3', sample_rate: 16000, channels: 1, bitrate: 64000 }, status: 'failed', requests_attempted: 1, chunks: [], words: [], conflicts: [], issues: ['network failure'] };
  for (const scope of ['analysis_point', 'analysis_point_review', 'transcript', 'observation', 'source_transcription']) {
    const edited = structuredClone(domainBase), a = edited.clipMentorAnalysis;
    if (scope === 'analysis_point') a.points[0].filming_conditions = ['wet skin'];
    if (scope === 'analysis_point_review') a.reviews[0].state = 'needs_revision';
    if (scope === 'transcript') a.transcripts[0].words[0].text = 'changed';
    if (scope === 'observation') a.observations.push({ observation_id: 'O', source_hash: 'a'.repeat(64), requested_times_seconds: [1], frame_evidence_ids: [],
      status: 'failed', method: 'source_frames_for_main_agent', at: 1, failure: 'extraction_failed_or_incomplete' });
    if (scope === 'source_transcription') a.source_transcription.issues = ['invalid timestamps'];
    await writeFile(old, JSON.stringify(domainBase)); await writeFile(fresh, JSON.stringify(edited));
    assert(JSON.parse(run(old, fresh, '--json')).changes.some((c: any) => c.scope === scope), 'report persisted domain change: ' + scope);
  }
  const missingTimeline = structuredClone(base); missingTimeline.activeTimelineId = 'missing';
  await writeFile(old, JSON.stringify(base)); await writeFile(fresh, JSON.stringify(missingTimeline));
  const pointerDelta = JSON.parse(run(old, fresh, '--json'));
  assert(pointerDelta.active_timeline_changed, 'migration repair must not hide a raw active pointer edit');
  assert(!run(old, fresh).includes('No compared delivery fields changed'));
  const large = structuredClone(base);
  large.assets = Array.from({ length: 80000 }, (_, i) => ({ id: 'a' + i, kind: 'audio', name: 'a', src: '/mock.mp3', durationInFrames: 30 }));
  const started = performance.now();
  assert.equal((await diffDeliveryCheck(large, large)).added_audio_assets, 0);
  assert(performance.now() - started < 5000, 'bounded large snapshot must not use quadratic audio lookup');
  const pointScale = structuredClone(domainBase);
  pointScale.clipMentorAnalysis.source_breakdown = { version: 1,
    segments: [{ segment_id: 'S', source_range_seconds: [1, 2], visible_evidence_ids: [], claim_evidence_ids: [], interpretation_evidence_ids: [], unknowns: [] }],
    points: Array.from({ length: 25000 }, (_, i) => ({ point_id: 'P' + i, segment_ids: ['S'], buying_concern: 'use', teaching_question: 'why',
      filming_conditions: [], role: 'primary', importance: 'must_explain' })),
    units: [{ unit_id: 'U', original_segment_ids: ['S'], explanation_segment_ids: ['S'],
      coverage: Array.from({ length: 25000 }, (_, i) => ({ point_id: 'P' + i, treatment: 'explain' })), revisits: [] }] };
  await writeFile(fresh, JSON.stringify(pointScale));
  const pointStarted = performance.now();
  assert.deepEqual(JSON.parse(run(fresh, fresh, '--json')).changes, []);
  assert(performance.now() - pointStarted < 5000, 'point coverage comparison must not rescan every coverage for every point');
  const oversized = join(dir, 'large.json'); await writeFile(oversized, ' '.repeat(16 * 1024 * 1024 + 1));
  assert.throws(() => run(old, oversized), 'snapshot inputs are size-bounded without changing any server limit');
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('Delivery diff: readonly CLI/help/JSON/errors, real changed/unchanged records, no film approval or model calls passed.');
