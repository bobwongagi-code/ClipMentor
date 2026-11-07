// Real saved contrasts verify preservation and handoff contracts, not a new
// language-quality classifier or fresh independent semantic qualification.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import corpus from './fixtures/barely-there-learning-20261030.json';
import saved from '../agent/tools/fixtures/barely-there-mg-replacement-20261030.json';
import type { ProjectDoc } from '../editor/types';
import { buildCopyTeachingReviewRequest, checkCopyProduction, copyTeachingPacketFromDoc, copyReviewCalibration, copyReviewSubject } from './production-gate';
import { apiCopyReviewDependencies } from '../../server/clipmentor/copy-review-api';

// Frozen coverage of this learning dataset only, not four mandatory groups or
// a fixed narration template for future products.
const requiredCases = { 'BT-METHOD': 'G2', 'BT-ORDER': 'G3', 'BT-CTA': 'G4', 'BT-KEEP': 'G1' };
function assertCaseInventory(input: typeof corpus) {
  assert.equal(new Set(input.cases.map(c => c.id)).size, input.cases.length, 'learning case IDs must be unique');
  for (const [id, group] of Object.entries(requiredCases)) {
    const entry = input.cases.find(c => c.id === id);
    assert(entry, `missing real learning contrast: ${id}`);
    assert.equal(entry.review_evidence.excerpt.group_id, group, `${id} must cite its actual scoped group`);
  }
  const sources = input.sources.map(s => s.id);
  assert.equal(new Set(sources).size, sources.length);
  for (const id of ['before_v1', 'current_saved_project', 'review_four_groups', 'human_comparison']) {
    assert(sources.includes(id), `missing source provenance: ${id}`);
  }
}

function assertSourceAvailability(available: boolean[]) {
  assert(available.every(Boolean) || available.every(v => !v), 'partial source archive must not silently skip provenance checks');
}

const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error('Network forbidden in learning regressions'); };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const doc = structuredClone(saved.before) as unknown as ProjectDoc;
const before = digest(doc);
const qualification = copyReviewCalibration();
let checks = 0;
try {
  assertCaseInventory(corpus); checks++;
  for (const id of Object.keys(requiredCases)) {
    const missing = structuredClone(corpus); missing.cases = missing.cases.filter(c => c.id !== id);
    assert.throws(() => assertCaseInventory(missing), /missing real learning contrast/); checks++;
  }
  const duplicate = structuredClone(corpus); duplicate.cases.push(duplicate.cases[0]);
  assert.throws(() => assertCaseInventory(duplicate), /unique/); checks++;
  const wrongGroup = structuredClone(corpus); wrongGroup.cases[0].review_evidence.excerpt.group_id = 'G1';
  assert.throws(() => assertCaseInventory(wrongGroup), /actual scoped group/); checks++;
  const packet = await copyTeachingPacketFromDoc(doc);
  assert.deepEqual(packet.units[0], corpus.context.current_unit, 'real saved context is preserved, including group order and cues'); checks++;
  assert.equal((await checkCopyProduction(doc, 'clipmentor')).code, 'copy_review_stale', 'historical delivery approval predates comparison-opening standards; preserve the original verdict without restamping'); checks++;
  for (const entry of corpus.cases) {
    const getLine = (side: unknown) => (side && typeof side === 'object' && 'narration_ms' in side ? side : null) as null | { id: string; narration_ms: string; caption_lines: string[]; meaning_zh: string };
    const older = getLine(entry.before) ?? getLine((entry.before as any).creator_invitation);
    const newer = getLine(entry.after) ?? getLine((entry.after as any).consumer_teaching);
    assert(older && newer, `${entry.id} must preserve its actual before/after excerpts`);
    if (older) {
      const original = corpus.context.before_lines.find(l => l.id === older.id)!;
      assert.equal(older.narration_ms, original.narration_ms);
      assert.deepEqual(older.caption_lines, original.caption_lines);
      assert.equal(older.meaning_zh, original.zh);
    }
    if (newer) {
      const actual: { narration_ms: string; caption_lines: string[]; meaning_zh: string } = packet.units[0].lines.find(l => l.line_id === newer.id)!;
      assert.equal(newer.narration_ms, actual.narration_ms);
      assert.deepEqual(newer.caption_lines, actual.caption_lines);
      assert.equal(newer.meaning_zh, actual.meaning_zh);
    }
    assert(['pass', 'needs_revision', 'insufficient_evidence'].includes(entry.review_evidence.excerpt.verdict), 'retain the scoped original verdict; pass is not a quality oracle'); checks++;
  }
  const kept = corpus.cases.find(c => c.id === 'BT-KEEP')!;
  assert.deepEqual(kept.before, kept.after, 'unchanged adequate teaching is a positive control'); checks++;
  const olderIds = corpus.context.before_lines.map(l => l.id);
  assert(!olderIds.includes('BT-L06'));
  assert(packet.units[0].lines.some(l => l.line_id === 'BT-L06'));
  assert(packet.delivery_sections!.some(s => s.kind === 'creator_invitation'), 'consumer teaching and creator CTA coexist'); checks++;
  const cta = corpus.cases.find(c => c.id === 'BT-CTA') as any;
  assert.deepEqual(cta.before.teaching_line_ids, olderIds);
  assert.deepEqual(cta.after.creator_action_sections, packet.delivery_sections, 'CTA case cannot silently borrow another stage or version'); checks++;

  // Author-case annotations cannot become expected answers for a new review.
  const marker = 'AUTHOR_CASE_ORACLE_MUST_NOT_REACH_REVIEWER';
  const annotated = structuredClone(packet) as any;
  annotated.case_expected_answer = marker;
  annotated.units[0].case_expected_answer = marker;
  annotated.units[0].picture_plan.execution_plan.content.case_expected_answer = marker;
  for (const section of annotated.delivery_sections) {
    section.line.case_expected_answer = marker;
    section.picture.author_reason = marker;
    section.voice.old_review_verdict = marker;
    if (section.voice.existing_audio) section.voice.existing_audio.case_expected_answer = marker;
    for (const evidence of section.evidence ?? []) evidence.old_review_reason = marker;
  }
  const request = buildCopyTeachingReviewRequest([{ case_id: 'neutral-current-subject', packet: annotated,
    expected: marker, author_reason: marker } as any]);
  assert(!JSON.stringify(request).includes(marker)); checks++;
  assert.deepEqual(request.input.cases[0].packet.delivery_sections, packet.delivery_sections,
    'projection must retain legitimate copy, image crop/display, evidence, voice and audio binding'); checks++;
  let apiInput: any;
  const api = apiCopyReviewDependencies({ provider: 'openai', model: 'synthetic-isolated-reviewer', origin: 'http://127.0.0.1:1', apiMode: 'responses' },
    (async (options: unknown) => { apiInput = options; return { text: '{"probe":"no_review_verdict"}' }; }) as never, {} as never);
  await api.run(JSON.stringify(request), [], 'synthetic-run', 'synthetic-project', new AbortController().signal);
  assert.equal(apiInput.messages.length, 1); assert.equal(apiInput.messages[0].role, 'user');
  assert.equal(apiInput.tools, undefined); assert.equal(apiInput.maxRetries, 0);
  assert(!JSON.stringify(apiInput).includes(marker)); checks++;
  const delivered = request.input.cases[0].packet.units[0].picture_plan!.execution_plan!.content;
  const expected = packet.units[0].picture_plan!.execution_plan!.content;
  assert.deepEqual(delivered.phases, expected.phases);
  assert.deepEqual(delivered.viewer_stage_cues, expected.viewer_stage_cues);
  assert.deepEqual(delivered.original_playback, expected.original_playback); checks++;
  // Synthetic admission controls only: one coherent example or two groups are
  // legal structures. They are not proposed edits or semantic approvals.
  for (const groupSizes of [[5], [2, 3]]) {
    const flexible = structuredClone(packet) as any, unit = flexible.units[0], plan = unit.picture_plan;
    const explanations = plan.execution_plan.content.phases.filter((p: any) => p.mode === 'explanation');
    const ends = groupSizes.length === 1 ? [37.266666666666666] : [19, 37.266666666666666];
    const originals = ends.map((end, i) => [i ? ends[i - 1] : 0, end]);
    plan.original_source_ranges = originals; plan.registered_revisits = [];
    plan.execution_plan.content.original_playback = { ranges: originals, purpose: 'Synthetic grouping structure control, not a proposed teaching plan' };
    plan.execution_plan.content.phases = [];
    let offset = 0;
    for (const [index, size] of groupSizes.entries()) {
      plan.execution_plan.content.phases.push({ mode: 'original', source_range_seconds: originals[index], picture: 'Synthetic coherent playback structure control' });
      for (const explanation of explanations.slice(offset, offset + size)) {
        plan.execution_plan.content.phases.push(explanation);
        plan.registered_revisits.push({ from_source_range: originals[index], to_source_range: explanation.source_range_seconds });
      }
      offset += size;
    }
    const accepted = buildCopyTeachingReviewRequest([{ case_id: 'synthetic-flexible-structure', packet: flexible }]);
    assert.deepEqual(accepted.input.cases[0].packet.units[0].picture_plan!.original_source_ranges, originals); checks++;
  }
  for (const mutation of [
    (v: any) => { v.units[0].picture_plan.execution_plan.content.phases.reverse(); },
    (v: any) => { v.units[0].picture_plan.execution_plan.content.phases.pop(); },
    (v: any) => { v.units[0].picture_plan.execution_plan.content.viewer_stage_cues.revisit = []; },
    (v: any) => { v.units[0].picture_plan.registered_revisits = []; },
  ]) {
    const invalid = structuredClone(packet); mutation(invalid);
    assert.throws(() => buildCopyTeachingReviewRequest([{ case_id: 'neutral-current-subject', packet: invalid }])); checks++;
  }
  // No new wording inherits the old approval; a learning fixture cannot approve it.
  const changed = structuredClone(doc);
  const internal = (changed.clipMentorAnalysis!.blueprint[0] as unknown as Record<string, any>).internal_review as Record<string, any>;
  internal[internal.current_script_candidate].lines.find((l: any) => l.id === 'BT-L02').narration_ms += ' Synthetic changed wording.';
  assert.equal((await checkCopyProduction(changed, 'clipmentor')).allowed, false); checks++;
  // Captured before this isolation fix on this exact synthetic metadata probe.
  // Never persist or present this deliberately altered receipt as an approval.
  const legacyHint = structuredClone(doc), analysis = legacyHint.clipMentorAnalysis!;
  const notes = (analysis.blueprint[0] as unknown as Record<string, any>).internal_review;
  notes[notes.current_picture_plan].delivery_sections[0].line.case_expected_answer = 'SYNTHETIC_LEGACY_AUTHOR_HINT';
  (analysis.production_copy_review!.teaching_review!.packet.delivery_sections![0].line as any).case_expected_answer = 'SYNTHETIC_LEGACY_AUTHOR_HINT';
  analysis.production_copy_review!.content_digest = 'bc25f68080a3a7f436865fd8c266917227cc2d8be0bc3aa8a754a67b5ed963cf';
  assert.notEqual((await copyReviewSubject(legacyHint)).digest, analysis.production_copy_review!.content_digest);
  assert.equal((await checkCopyProduction(legacyHint, 'clipmentor')).allowed, false, 'old exposed-author-metadata approval must be stale'); checks++;
  assert.equal(digest(doc), before);
  assert.deepEqual(copyReviewCalibration(), qualification, 'learning cases do not requalify the frozen blind baseline'); checks++;
  // Audit full source hashes where the production archive exists; portable CI
  // needs only the captured excerpts, never a developer's home directory.
  let audited = 0;
  const sourceFiles = corpus.sources.map(source => new URL('../../../' + source.path, import.meta.url));
  assertSourceAvailability(sourceFiles.map(file => existsSync(file))); checks++;
  assertSourceAvailability([false, false]); assertSourceAvailability([true, true]);
  assert.throws(() => assertSourceAvailability([true, false]), /partial source archive/); checks++;
  for (const [index, source] of corpus.sources.entries()) {
    const file = sourceFiles[index];
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
    if (source.id === 'before_v1') {
      const original = JSON.parse(bytes.toString());
      assert.deepEqual(corpus.context.before_lines, original.narration_and_captions);
      assert.deepEqual(corpus.context.before_picture_rows, original.estimated_picture_timeline.rows);
      assert.deepEqual(corpus.context.market_background, original.product_judgment);
    }
    if (source.id === 'current_saved_project') {
      const original = JSON.parse(bytes.toString()).clipMentorAnalysis.production_copy_review.teaching_review.packet;
      assert.deepEqual(corpus.context.current_unit, original.units[0]);
    }
    if (source.id === 'review_four_groups') {
      const original = JSON.parse(bytes.toString());
      for (const entry of corpus.cases) {
        const index = Number(entry.review_evidence.pointer.split('/').at(-1));
        assert.deepEqual(entry.review_evidence.excerpt, original.groups[index], 'review excerpt must be exact, not a retold approval');
      }
    }
    audited++;
  }
  assert.equal(calls, 0);
  console.log(`barely-there-learning.verify: ${checks} contract checks; ${audited} original source hashes; zero network. Semantic discrimination not re-tested.`);
} finally { globalThis.fetch = originalFetch; }
