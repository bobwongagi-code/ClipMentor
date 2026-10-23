import assert from 'node:assert/strict';
import {
  assertExternalVideoUrlSize, buildPreviewReviewRequest, evaluatePreviewTeachingJudgment,
  reviewClipMentorPreview, validatePreviewReviewInput,
} from './preview-review.ts';
import type { PreviewReviewInput, PreviewTeachingJudgment, ReviewReceipt } from './preview-review.ts';

const input: PreviewReviewInput = {
  duration_seconds: 10,
  points: [{ point_id: 'P1', teaching_goal_zh: '近镜同框便于观察两侧', product_relevance: '局部外观的比较' }],
  units: [{ unit_id: 'U1', point_ids: ['P1'] }],
  reference_text: [{ channel: 'narration', start_seconds: 5, end_seconds: 10, text: 'Dua tangan dalam satu paparan, senang banding.' }],
};
const original: ReviewReceipt = { start_seconds: 0, end_seconds: 4, channel: 'original', observed: '两手加入同框' };
const explanation: ReviewReceipt = { start_seconds: 5, end_seconds: 9, channel: 'narration', observed: '说明同框方便比较', quote: input.reference_text[0].text };
const finding = () => ({ status: 'supported' as const, reasoning: '具体引用说明比较的作用', evidence: [structuredClone(explanation)] });
const good = (): PreviewTeachingJudgment => ({
  coverage: [{ point_id: 'P1', depiction: [original], teaching: finding() }],
  continuity: [{ unit_id: 'U1', point_ids: ['P1'], previous: [original], current: [explanation],
    relation: 'recap', narrative: finding(), teaching: finding() }],
});

for (const value of [['narration'], [['narration']], null, {}, true, 0]) {
  const invalid = structuredClone(input); Object.assign(invalid.reference_text[0], { channel: value });
  assert.throws(() => validatePreviewReviewInput(invalid), 'reference channel must be scalar');
}
for (const [target, field] of [['receipt', 'channel'], ['finding', 'status'], ['continuity', 'relation']] as const) {
  for (const value of [null, {}, true, 0, ['supported'], ['recap'], ['narration']]) {
    const invalid = good();
    const row = target === 'receipt' ? invalid.coverage[0].teaching.evidence[0] : target === 'finding' ? invalid.coverage[0].teaching : invalid.continuity[0];
    Object.assign(row, { [field]: value });
    assert.equal(evaluatePreviewTeachingJudgment(invalid, input).status, 'review_required', `invalid ${target}.${field}`);
  }
}

assert.doesNotThrow(() => assertExternalVideoUrlSize(14_525_235));
assert.throws(() => assertExternalVideoUrlSize(42_647_784), /15MB/);
assert.doesNotThrow(() => assertExternalVideoUrlSize(15_000_000));
assert.throws(() => assertExternalVideoUrlSize(15_000_001));
const video = new Uint8Array([1, 2, 3, 4]);
const built = buildPreviewReviewRequest(video, input);
assert.equal(buildPreviewReviewRequest(video, input).request_sha256, built.request_sha256);
assert.notEqual(buildPreviewReviewRequest(new Uint8Array([1, 2, 3, 5]), input).request_sha256, built.request_sha256);
const request = JSON.parse(built.body);
assert.deepEqual(Buffer.from(request.contents[0].parts[0].inlineData.data, 'base64'), Buffer.from(video));
assert.equal(request.contents[0].parts[0].fileData, undefined);
assert.equal(request.generationConfig.maxOutputTokens, 16_384);
assert.throws(() => buildPreviewReviewRequest(new Uint8Array(75_000_001), input), /size/);
assert.throws(() => buildPreviewReviewRequest(new Uint8Array(), input), /size/);
assert.throws(() => validatePreviewReviewInput({ ...input, points: [...input.points, ...input.points] }), /duplicate/);
const clean = validatePreviewReviewInput({ ...input, expected_verdict: 'must fail', author_review: 'already passed' });
assert.equal(JSON.stringify(clean).includes('must fail'), false);
assert.equal(JSON.stringify(clean).includes('already passed'), false);

assert.equal(evaluatePreviewTeachingJudgment(good(), input).status, 'pass'); // A legitimate recap is allowed.
assert.equal(evaluatePreviewTeachingJudgment(good(), input).full_film_accepted, false);
const splitReference: PreviewReviewInput = { ...input, reference_text: [
  { channel: 'narration', start_seconds: 5, end_seconds: 7, text: 'Dua tangan dalam satu paparan,' },
  { channel: 'narration', start_seconds: 7, end_seconds: 10, text: 'senang banding.' },
] };
assert.equal(evaluatePreviewTeachingJudgment(good(), splitReference).status, 'pass', 'A quote may span consecutive caption cards');
const missing = good(); missing.coverage = [];
assert.ok(evaluatePreviewTeachingJudgment(missing, input).issues.includes('P1:missing_coverage'));
const appearance = good(); appearance.coverage[0].teaching.evidence = [original];
assert.ok(evaluatePreviewTeachingJudgment(appearance, input).issues.includes('P1:appearance_not_teaching'));
const unsupported = good(); unsupported.continuity[0].teaching.evidence = [];
assert.ok(evaluatePreviewTeachingJudgment(unsupported, input).issues.includes('U1:teaching:unsupported_positive'));
const narrativeOnly = good(); narrativeOnly.continuity[0].teaching.status = 'insufficient_evidence';
assert.equal(evaluatePreviewTeachingJudgment(narrativeOnly, input).status, 'review_required');
assert.equal(narrativeOnly.continuity[0].narrative.status, 'supported');
const omittedTeachingPoint = good(); omittedTeachingPoint.coverage[0].teaching.status = 'not_supported';
const unitGate = evaluatePreviewTeachingJudgment(omittedTeachingPoint, input);
assert.equal(unitGate.unit_results[0].model_narrative, 'supported');
assert.equal(unitGate.unit_results[0].teaching_status, 'review_required');
assert.equal(omittedTeachingPoint.continuity[0].teaching.status, 'supported', 'Raw model opinions must not be rewritten by the gate');
const falseQuote = good(); falseQuote.coverage[0].teaching.evidence[0].quote = 'Terbukti berkesan serta-merta';
assert.ok(evaluatePreviewTeachingJudgment(falseQuote, input).issues.includes('P1:unverified_quote'));
const wrongTime = good(); wrongTime.coverage[0].teaching.evidence[0].end_seconds = 11;
assert.equal(evaluatePreviewTeachingJudgment(wrongTime, input).status, 'review_required');
const noBack = good(); noBack.continuity[0].previous = [];
assert.ok(evaluatePreviewTeachingJudgment(noBack, input).issues.includes('U1:missing_front_back_evidence'));
const absentUnit = good(); absentUnit.continuity = [];
assert.ok(evaluatePreviewTeachingJudgment(absentUnit, input).issues.includes('U1:missing_continuity'));
const visual = good(); visual.coverage[0].teaching.evidence = [{ start_seconds: 5, end_seconds: 9,
  channel: 'visual_organization', observed: '两侧在同一近镜中并置，可同时观察对应位置' }];
assert.equal(evaluatePreviewTeachingJudgment(visual, input).status, 'pass'); // No mandatory spoken formula.

let calls = 0;
const result = await reviewClipMentorPreview(video, input, { key: 'private-test-value', post: async (body, key, signal) => {
  calls++; assert.equal(key, 'private-test-value'); assert.equal(body.includes(key), false); assert.ok(signal);
  return { status: 200, body: { modelVersion: 'test-model', usageMetadata: { totalTokenCount: 20 }, candidates: [
    { finishReason: 'STOP', content: { parts: [{ thought: true, text: 'not public' }, { text: JSON.stringify(good()) }] } },
  ] } };
} });
assert.equal(calls, 1); assert.equal(result.status, 'pass'); assert.equal(result.full_film_accepted, false);
assert.equal(result.raw_public_judgment.includes('not public'), false);
assert.equal(JSON.stringify(result).includes('private-test-value'), false);
let failures = 0;
await assert.rejects(() => reviewClipMentorPreview(video, input, { key: 'private-test-value', post: async () => {
  failures++; throw new Error('Authorization: private-test-value');
} }), (error: Error) => !error.message.includes('private-test-value') && error.message.includes('no automatic retry'));
assert.equal(failures, 1);
await assert.rejects(() => reviewClipMentorPreview(video, input, { key: 'private-test-value', post: async () => ({ status: 400,
  body: { error: 'private-test-value' } }) }), (error: Error) => error.message.includes('HTTP 400') && !error.message.includes('private-test-value'));
await assert.rejects(() => reviewClipMentorPreview(video, input, { key: 'private-test-value', post: async () => ({ status: 200,
  body: { usageMetadata: { secret: 'private-test-value' }, candidates: [] } }) }), /credential echo/);
const malformed = await reviewClipMentorPreview(video, input, { key: 'private-test-value', post: async () => ({ status: 200,
  body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not JSON' }] } }] } }) });
assert.equal(malformed.status, 'review_required');
const fenced = await reviewClipMentorPreview(video, input, { key: 'private-test-value', post: async () => ({ status: 200,
  body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '```json\n' + JSON.stringify(good()) + '\n```' }] } }] } }) });
assert.equal(fenced.status, 'pass', 'A complete JSON code fence is a transport wrapper, not a semantic repair');
const partial = await reviewClipMentorPreview(video, input, { key: 'private-test-value', post: async () => ({ status: 200,
  body: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: JSON.stringify(good()) }] } }] } }) });
assert.equal(partial.status, 'review_required'); assert.ok(partial.issues.includes('incomplete_generation'));
console.log('Preview review: input-size guards, exact inline bytes, independent receipts, teaching-vs-narrative gates, quoted-text checks, safe failures and no retries passed.');
