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

const emptyVisual=structuredClone(visual);emptyVisual.coverage[0].teaching.evidence[0].quote='';
assert.equal(evaluatePreviewTeachingJudgment(emptyVisual,input).status,'pass','optional visual quote does not require invented speech');
const emptySpoken=good();emptySpoken.coverage[0].teaching.evidence[0].quote='';
assert.equal(evaluatePreviewTeachingJudgment(emptySpoken,input).status,'review_required','spoken claims still need verified words');
const emptyOriginal=structuredClone(appearance);emptyOriginal.coverage[0].teaching.evidence[0].quote='';
assert.notEqual(evaluatePreviewTeachingJudgment(emptyOriginal,input).status,'pass','original appearance is not teaching approval');

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

// Model observation times are display precision, never native edit boundaries.
const roundedInput={...structuredClone(input),duration_seconds:10+2/3};
const roundedGood=good();roundedGood.coverage[0].teaching.evidence[0].end_seconds=10.67;
assert.equal(evaluatePreviewTeachingJudgment(roundedGood,roundedInput).status,'pass','centisecond-rounded EOF is valid observational evidence');
const overRounded=structuredClone(roundedGood);overRounded.coverage[0].teaching.evidence[0].end_seconds=10.68;
assert.equal(evaluatePreviewTeachingJudgment(overRounded,roundedInput).status,'review_required','real EOF overrun is still refused');
assert.throws(()=>validatePreviewReviewInput({...roundedInput,reference_text:[{...input.reference_text[0],end_seconds:10.67}]}),'scheduled text ranges remain exact');
const {previewBoundaryRevalidation}=await import('./preview-review.ts');
const roundedSaved={status:'review_required',issues:['invalid_coverage_row','P1:missing_coverage'],finish_reasons:['STOP'],raw_public_judgment:JSON.stringify(roundedGood),judgment:roundedGood};
const immutable=JSON.stringify(roundedSaved);assert(previewBoundaryRevalidation(roundedSaved,roundedInput));assert.equal(JSON.stringify(roundedSaved),immutable);
assert.equal(previewBoundaryRevalidation({...roundedSaved,issues:['P1:unverified_quote']},roundedInput),null);
assert.equal(previewBoundaryRevalidation({...roundedSaved,finish_reasons:['MAX_TOKENS']},roundedInput),null);
assert.equal(previewBoundaryRevalidation({...roundedSaved,judgment:overRounded},roundedInput),null);
const negative=structuredClone(roundedGood);negative.coverage[0].teaching.status='not_supported';assert.equal(previewBoundaryRevalidation({...roundedSaved,judgment:negative},roundedInput),null);
assert.equal(previewBoundaryRevalidation({...roundedSaved,judgment:good()},roundedInput),null,'old negative status cannot be generally bypassed');
console.log('EOF rounding: observations only, exact input ranges, frozen negative/quote/finish gates and immutable local revalidation passed');

assert.equal(previewBoundaryRevalidation({...roundedSaved,raw_public_judgment:'{}'},roundedInput),null,'derived rounding metadata requires the original matching raw judgment');

// A physical film origin has no previous frame interval; never fabricate one.
const originInput={...structuredClone(input),units:[{...input.units[0],output_range_seconds:[0,10] as [number,number]}]};
const originGood=good();originGood.continuity[0].relation='new_information';
originGood.continuity[0].current=[{start_seconds:0,end_seconds:10,channel:'visual_organization',observed:'成绩片头接入清晰原片'}];
originGood.continuity[0].previous=[{start_seconds:0,end_seconds:0,channel:'visual_organization',observed:'视频起点'}];
assert.equal(evaluatePreviewTeachingJudgment(originGood,originInput).status,'pass');
const noPredecessor=structuredClone(originGood);noPredecessor.continuity[0].previous=[];
assert.equal(evaluatePreviewTeachingJudgment(noPredecessor,originInput).status,'pass','canonical empty predecessor at the physical origin');
for(const previous of [
 [{start_seconds:1,end_seconds:1,channel:'visual_organization',observed:'not origin'}],
 [{start_seconds:0,end_seconds:0,channel:'narration',observed:'not frame evidence'}],
 [{start_seconds:0,end_seconds:0,channel:'visual_organization',observed:'origin',quote:'invented'}],
 [...originGood.continuity[0].previous,...originGood.continuity[0].previous],
]){const bad=structuredClone(originGood);bad.continuity[0].previous=previous as ReviewReceipt[];assert.equal(evaluatePreviewTeachingJudgment(bad,originInput).status,'review_required');}
assert.equal(evaluatePreviewTeachingJudgment(originGood,{...originInput,units:[{...originInput.units[0],output_range_seconds:[1,10]}]}).status,'review_required','later units still need a real predecessor');
const missingOrigin=structuredClone(originGood);missingOrigin.continuity[0].current[0].start_seconds=1;
assert.equal(evaluatePreviewTeachingJudgment(missingOrigin,originInput).status,'review_required');
const fakeCoverage=structuredClone(originGood);fakeCoverage.coverage[0].depiction=originGood.continuity[0].previous;
assert.equal(evaluatePreviewTeachingJudgment(fakeCoverage,originInput).status,'review_required','boundary sentinel is never depiction evidence');
const originSaved={status:'review_required',issues:['invalid_continuity_row','U1:missing_continuity'],finish_reasons:['STOP'],raw_public_judgment:JSON.stringify(originGood),judgment:originGood};
const originBefore=JSON.stringify(originSaved);
assert.equal(previewBoundaryRevalidation(originSaved,originInput)?.method,'film-origin-continuity-v1');
const emptyOriginSaved={...originSaved,issues:['U1:missing_front_back_evidence'],judgment:noPredecessor,raw_public_judgment:JSON.stringify(noPredecessor)};
const emptyOriginBefore=JSON.stringify(emptyOriginSaved);
assert.equal(previewBoundaryRevalidation(emptyOriginSaved,originInput)?.method,'film-origin-continuity-v1','legacy empty predecessor error is recoverable only at the actual film origin');
assert.equal(JSON.stringify(emptyOriginSaved),emptyOriginBefore,'canonical origin recovery preserves raw judgment and original rejection');
assert.equal(previewBoundaryRevalidation({...emptyOriginSaved,issues:['another:missing_front_back_evidence']},originInput),null,'an origin elsewhere cannot excuse missing evidence in a different unit');
assert.equal(previewBoundaryRevalidation(emptyOriginSaved,{...originInput,units:[{...originInput.units[0],output_range_seconds:[1,10]}]}),null,'a later segment still needs predecessor evidence');

assert.equal(JSON.stringify(originSaved),originBefore,'saved raw/negative result remains immutable');
assert.equal(previewBoundaryRevalidation({...originSaved,raw_public_judgment:'{}'},originInput),null);
assert.equal(previewBoundaryRevalidation({...originSaved,finish_reasons:['MAX_TOKENS']},originInput),null);
const negativeOrigin=structuredClone(originGood);negativeOrigin.continuity[0].teaching.status='insufficient_evidence';
assert.equal(previewBoundaryRevalidation({...originSaved,judgment:negativeOrigin,raw_public_judgment:JSON.stringify(negativeOrigin)},originInput),null,'no semantic result is overridden');
console.log('Film origin: exact first-unit scope, empty/zero boundary markers, real current/teaching evidence, later-unit refusal and immutable raw-bound revalidation passed');
