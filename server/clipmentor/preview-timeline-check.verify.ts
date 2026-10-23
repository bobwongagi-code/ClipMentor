import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPreviewTimelineObservations } from './preview-timeline-check.ts';
import { auditSavedPreview, renderTimelineAudit } from './preview-timeline-check.mts';
import { type PreviewTeachingJudgment, type PreviewReviewInput, type ReviewReceipt } from './preview-review.ts';

const manifest = { fps: 30, total_frames: 600, scenes: [
  { start_frame: 0, end_frame: 60, kind: 'video', content: 20 },
  { start_frame: 60, end_frame: 153, kind: 'relation', content: [21, 22] },
  { start_frame: 153, end_frame: 159, kind: 'still', content: 22, label: 'breath' },
  { start_frame: 159, end_frame: 300, kind: 'original', content: 30 },
  { start_frame: 300, end_frame: 308, kind: 'still', content: 42, label: 'breath' },
  { start_frame: 308, end_frame: 368, kind: 'video', content: 40 },
  { start_frame: 368, end_frame: 428, kind: 'still', content: 42 },
  { start_frame: 428, end_frame: 473, kind: 'video', content: 42 },
  { start_frame: 473, end_frame: 600, kind: 'still', content: 43 },
], audios: [{ start: 0, end: 5.11, kind: 'voice' }, { start: 5.31, end: 10.01, kind: 'original' }, { start: 10.27, end: 20, kind: 'voice' }] };
const input: PreviewReviewInput = { duration_seconds: 20, points: [
  { point_id: 'P1', teaching_goal_zh: '气味讲解到比较的承接', product_relevance: '气味' },
  { point_id: 'P2', teaching_goal_zh: '泡沫与湿肤回顾', product_relevance: '使用过程' },
], units: [{ unit_id: 'transition-1', point_ids: ['P1'] }, { unit_id: 'transition-2', point_ids: ['P2'] }],
reference_text: [{ channel: 'narration', start_seconds: 10.27, end_seconds: 20, text: 'kulit basah' }] };
const receipt = (a: number, b: number, observed: string): ReviewReceipt => ({ start_seconds: a, end_seconds: b, channel: 'visual_organization', observed });
const supported = (evidence: ReviewReceipt[]) => ({ status: 'supported' as const, reasoning: '独立意见保持原样', evidence });
const judgment: PreviewTeachingJudgment = { coverage: [
  { point_id: 'P1', depiction: [receipt(2, 5.11, '关系图')], teaching: supported([receipt(2, 5.11, '关系图')]) },
  { point_id: 'P2', depiction: [receipt(10.27, 20, '回顾')], teaching: supported([
    receipt(10.27, 14.27, '展示带泡沫的双手定格图'), receipt(14.27, 20, '展示洗净湿润的手肘特写定格图'),
  ]) },
], continuity: [
  { unit_id: 'transition-1', point_ids: ['P1'], previous: [receipt(2, 5.11, '讲解')], current: [receipt(5.3, 6, '原片')], relation: 'new_information',
    narrative: supported([receipt(5.11, 5.6, '从分析图切回原片动态播放')]), teaching: supported([receipt(5.3, 6, '原片')]) },
  { unit_id: 'transition-2', point_ids: ['P2'], previous: [receipt(9, 10, '原片')], current: [receipt(10.27, 20, '回顾')], relation: 'recap',
    narrative: supported([receipt(10, 10.3, '画面从原片切换为教学分解静态卡片')]),
    teaching: supported([receipt(10.27, 20, '依次调出双手泡沫和湿手肘两张回顾画面配合旁白')]) },
] };
const saved = { judgment, full_film_accepted: false, raw_public_judgment: JSON.stringify(judgment) };
const before = JSON.stringify({ manifest, saved, input });
const report = checkPreviewTimelineObservations(manifest, saved, input);
const codes = (index: number) => report.units[index].issues.map(i => i.code);
assert(codes(0).includes('pause_not_separately_described'));
assert(codes(0).includes('pause_used_in_positive_evidence'));
assert(!codes(0).includes('static_description_over_video'), 'transition range spanning a cut is not an exact claim of its start');
assert(report.units[0].cut_checks.every(c => c.timestamp_check === 'range_context_only_exact_cut_not_asserted'));
assert(codes(1).includes('static_description_over_video'), 'explicit static descriptions overlap actual video segments');
assert(codes(1).includes('possible_dynamic_omission'), 'image summary remains ambiguous, not a proven false observation');
assert(codes(1).includes('wording_requires_evidence'));
assert(report.units[1].issues.filter(i => i.code === 'static_description_over_video').length === 1, 'merge repeated evidence, do not give user a flag per receipt');
assert.equal(report.units[1].model_verdict_preserved.teaching.status, 'supported');
assert.equal(report.full_film_accepted, false);
assert.equal(report.new_model_calls, 0);
assert.equal(JSON.stringify({ manifest, saved, input }), before, 'must not rewrite raw judgment, copy or manifest');
const actualVideo = report.units[1].actual_segments.find(s => s.scene_index === 5)!;
assert.equal(actualVideo.source_start_seconds, 40);
assert.equal(actualVideo.start_seconds, 308 / 30, 'output and source clocks remain distinct');
assert(Math.abs(report.units[0].scheduled_audio_gaps[0].duration_seconds - .2) < 1e-10);

// Positive control: explicit mixed media with a separately described pause is not a
// conflict; benign evidence must not be rejected just to reproduce the old failure.
const accurate = structuredClone(saved);
for (const c of accurate.judgment.coverage) {
  c.depiction.forEach(r => r.observed = '动态与静帧混合，气口保留画面');
  c.teaching.evidence.forEach(r => r.observed = '动态视频与静帧混合展示，breath为停顿画面');
}
for (const u of accurate.judgment.continuity) for (const r of [...u.previous, ...u.current, ...u.narrative.evidence, ...u.teaching.evidence]) r.observed = '动态视频与静帧混合展示，breath为停顿画面';
const control = checkPreviewTimelineObservations(manifest, accurate, input);
assert.equal(control.status, 'no_detected_conflict');
assert.equal(control.full_film_accepted, false);
for (const phrase of ['不是两张静图，而是动态与静态交替', '并非静态卡片', '两张图配合视频', '手部展示']) {
  const neutral = structuredClone(accurate);
  neutral.judgment.coverage[1].teaching.evidence[0].observed = phrase;
  assert(!checkPreviewTimelineObservations(manifest, neutral, input).units[1].issues.some(i => i.code === 'static_description_over_video' || i.code === 'possible_dynamic_omission'), phrase);
}
const staticOnly = structuredClone(accurate);
staticOnly.judgment.coverage[1].teaching.evidence = [receipt(12.27, 14.266, '双手定格图')];
assert(!checkPreviewTimelineObservations(manifest, staticOnly, input).units[1].issues.some(i => i.code === 'static_description_over_video'));
const exclusive = structuredClone(accurate);
exclusive.judgment.coverage[1].teaching.evidence = [receipt(10.27, 20, '全程只有两张静图')];
assert.equal(checkPreviewTimelineObservations(manifest, exclusive, input).units[1].issues.find(i => i.code === 'static_description_over_video')?.certainty, 'execution_description_conflict');
assert.equal(report.units[1].observation_checks.find(c => c.path === 'coverage.P2.teaching.evidence[0]')?.medium_claim_check, 'static_summary_over_mixed_media');
const roundedPause = structuredClone(accurate);
roundedPause.judgment.continuity[1].teaching.evidence = [receipt(10.266, 11, '动态视频')];
// Do not attribute a positive claim to the pause for a sub-5ms rounded edge.
roundedPause.judgment.continuity[1].narrative.evidence = [receipt(10.27, 11, '动态视频')];
for (const r of [...roundedPause.judgment.coverage[1].depiction, ...roundedPause.judgment.coverage[1].teaching.evidence,
  ...roundedPause.judgment.continuity[1].previous, ...roundedPause.judgment.continuity[1].current]) r.observed = '动作展示';
assert(!checkPreviewTimelineObservations(manifest, roundedPause, input).units[1].issues.some(i => i.code === 'pause_used_in_positive_evidence'));
const withRoundedEnd = structuredClone(staticOnly);
withRoundedEnd.judgment.coverage[1].teaching.evidence[0].end_seconds = 14.27;
assert(!checkPreviewTimelineObservations(manifest, withRoundedEnd, input).units[1].issues.some(i => i.code === 'static_description_over_video'), '3.3ms adjacent video overlap is only two-decimal rounding');
assert.throws(() => checkPreviewTimelineObservations(manifest, { ...saved, judgment: {} }, input));
const outOfBounds = structuredClone(saved);
outOfBounds.judgment.continuity[1].current[0].end_seconds = 20.01;
assert.throws(() => checkPreviewTimelineObservations(manifest, outOfBounds, input), 'model range beyond duration cannot be accepted');
const discontinuous = structuredClone(manifest); discontinuous.scenes[1].start_frame++;
assert.throws(() => checkPreviewTimelineObservations(discontinuous, saved, input));
assert.throws(() => checkPreviewTimelineObservations(manifest, saved, { ...input, duration_seconds: 21 }));
assert.throws(() => checkPreviewTimelineObservations(manifest, { ...saved, full_film_accepted: true }, input));

// Real local files, operation/video/input/raw-response binding; never sends requests.
const directory = await mkdtemp(join(tmpdir(), 'clipmentor-observation-check-'));
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
try {
  const operation = 'b4fa8fdb-87ec-4280-8c58-86f42b0b3e60';
  const video = 'local mock video bytes, not a decoder test';
  const bound = { ...saved, video_sha256: digest(video), input_sha256: digest(JSON.stringify(input)) };
  const binding = { operationId: operation, videoSha256: bound.video_sha256, inputSha256: bound.input_sha256 };
  const args: Record<string, string> = { operation };
  for (const [key, value] of Object.entries({ manifest, review: bound, input, binding, video })) {
    args[key] = join(directory, key);
    await writeFile(args[key], typeof value === 'string' ? value : JSON.stringify(value));
  }
  const local = await auditSavedPreview(args);
  assert.equal(local.provenance.operation_id, operation);
  assert(renderTimelineAudit(local).includes('不批准成片'));
  assert.equal(await readFile(args.review, 'utf8'), JSON.stringify(bound));
  await assert.rejects(auditSavedPreview({ ...args, operation: '00000000-0000-4000-8000-000000000000' }));
  await writeFile(args.video, 'changed'); await assert.rejects(auditSavedPreview(args)); await writeFile(args.video, video);
  await writeFile(args.input, JSON.stringify({ ...input, points: input.points.slice(0, 1) })); await assert.rejects(auditSavedPreview(args)); await writeFile(args.input, JSON.stringify(input));
  await writeFile(args.review, JSON.stringify({ ...bound, raw_public_judgment: '{}' })); await assert.rejects(auditSavedPreview(args));
} finally { await rm(directory, { recursive: true, force: true }); }
console.log('preview timeline check: conflicts, positive controls, ambiguity, rounding, provenance and zero-mutation checks passed');
