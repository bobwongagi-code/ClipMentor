import assert from 'node:assert/strict';
import { checkTransitionManifest } from './transition-check.mts';

// Source positions and frame boundaries come from execution, not author-asserted layout flags.
const manifest = { fps: 30, total_frames: 600, scenes: [
  { start_frame: 0, end_frame: 93, kind: 'relation', content: [60.6, 62.2] },
  { start_frame: 93, end_frame: 99, kind: 'still', content: 62.2, label: 'breath' },
  { start_frame: 99, end_frame: 600, kind: 'original', content: 69.8 },
], lines: [{ line_id: 'long-but-informative-control', start: 0, end: 3.1 }] };
// A video's source timestamp is its IN point; the preceding boundary is its last displayed frame.
const moving = { fps: 30, total_frames: 180, scenes: [
  { start_frame: 0, end_frame: 90, kind: 'video', content: 56 },
  { start_frame: 90, end_frame: 96, kind: 'still', content: 56, label: 'breath' },
  { start_frame: 96, end_frame: 180, kind: 'original', content: 69.8 },
] };
assert(checkTransitionManifest(moving).candidates.some((c) => c.code === 'pause_inserts_picture'), 'holding the video IN frame jumps backward');
const endHold = structuredClone(moving); endHold.scenes[1].content = 56 + 89 / 30;
assert.equal(checkTransitionManifest(endHold).candidates.length, 0, 'holding the actual final frame is continuous');
const throughBreath = { ...moving, scenes: [
  { start_frame: 0, end_frame: 90, kind: 'relation', content: [60.6, 62.2] },
  { start_frame: 90, end_frame: 96, kind: 'still', content: 62.2, label: 'breath' },
  { start_frame: 96, end_frame: 180, kind: 'still', content: 62.2 },
] };
assert.deepEqual(checkTransitionManifest(throughBreath).candidates.map((c) => c.code), ['composition_change'], 'breath must not exempt composition change even when the pause continues into the next view');
for (const fps of [25, 30, 30000 / 1001]) {
  const control = structuredClone(moving); control.fps = fps;
  control.scenes[1].content = 56 + 89 / fps;
  assert.equal(checkTransitionManifest(control).candidates.length, 0, 'hold at the departing frame at the actual output fps');
  control.scenes[1].content = 56 + 88 / fps;
  assert(checkTransitionManifest(control).candidates.some(c => c.code === 'pause_inserts_picture'), 'a whole frame difference is not float noise');
}
const nextEntry = structuredClone(moving);
nextEntry.scenes[0] = { ...nextEntry.scenes[0], kind: 'original', content: 43 };
nextEntry.scenes[1] = { ...nextEntry.scenes[1], kind: 'video', content: 60 };
nextEntry.scenes[2] = { ...nextEntry.scenes[2], kind: 'video', content: 60 + 5 / 30 };
assert.equal(checkTransitionManifest(nextEntry).candidates.length, 0, 'a moving pause can arrive at the next shot source boundary');
const beforeRelation = structuredClone(throughBreath);
beforeRelation.scenes.reverse();
// Restore chronological output ranges after reversing the picture roles.
beforeRelation.scenes.forEach((s, i) => Object.assign(s, { start_frame: [0, 90, 96][i], end_frame: [90, 96, 180][i] }));
assert.deepEqual(checkTransitionManifest(beforeRelation).candidates.map(c => c.code), ['composition_change']);
const invalidKind = structuredClone(moving);
Object.assign(invalidKind.scenes[0], { kind: ['video'] });
assert.throws(() => checkTransitionManifest(invalidKind), 'kind must be a scalar enum');

// Union all audio coverage: an overlapping short track cannot invent silence.
const withAudio = { ...manifest, audios: [
  { start: 0, end: 20, kind: 'original' }, { start: 1, end: 2, kind: 'voice' }, { start: 8, end: 9, kind: 'voice' },
] };
const union = checkTransitionManifest(withAudio) as any;
assert.deepEqual(union.audio_gaps, [], 'a full-length track covers all nested tracks');
assert.deepEqual((checkTransitionManifest({ ...withAudio, audios: [...withAudio.audios].reverse() }) as any).audio_gaps, [], 'input order cannot invent gaps');
const soundGap = checkTransitionManifest({ ...manifest, audios: [{ start: 0, end: 3.2, kind: 'voice' }, { start: 3.4, end: 20, kind: 'original' }] }) as any;
assert.equal(soundGap.audio_gaps.length, 1);
assert(Math.abs(soundGap.audio_gaps[0].duration_seconds - .2) < 1e-12);
assert.equal(soundGap.review_groups.length, 1, 'overlapping/touching picture and gap signals form one agent task');
assert.equal(soundGap.review_groups[0].next_action, 'agent_inspect');
assert.equal(soundGap.human_review_requested, false);
assert.equal(soundGap.semantic_review, 'not_performed');
assert.equal(soundGap.full_film_accepted, false);
const allChanges = { fps: 30, total_frames: 210, scenes: Array.from({ length: 7 }, (_, i) => ({
  start_frame: i * 30, end_frame: (i + 1) * 30, kind: i % 2 ? 'relation' : 'still', content: i % 2 ? [1, 2] : 2,
})), audios: [{ start: 0, end: 7, kind: 'voice' }] };
const sweep = checkTransitionManifest(allChanges) as any;
assert.equal(sweep.cut_events.length, 6, 'later layout changes must remain visible after the first group');
assert.equal(sweep.layout_change_pairs.length, 5);
assert.equal(sweep.layout_change_pairs.at(-1).to_seconds, 6);
const mediaOnly = checkTransitionManifest({ fps: 30, total_frames: 60, scenes: [
  { start_frame: 0, end_frame: 30, kind: 'video', content: 0 },
  { start_frame: 30, end_frame: 60, kind: 'still', content: 1 },
], audios: [{ start: 0, end: 2, kind: 'voice' }] }) as any;
assert.equal(mediaOnly.cut_events[0].layout_changed, false, 'video to still is not necessarily a layout change');
assert.equal(mediaOnly.cut_events[0].medium_changed, true);
assert.equal(mediaOnly.review_groups.length, 0, 'a media-type change alone is not a quality warning');
for (const audios of [null, {}, [{ start: 0, end: NaN }], [{ start: 2, end: 1 }], [{ start: 0, end: 21 }], [{ start: '0', end: 1 }]]) {
  assert.throws(() => checkTransitionManifest({ ...manifest, audios }), 'invalid audio cannot silently count as a clean check');
}
assert.equal((checkTransitionManifest(manifest) as any).audio_check, 'not_provided');
const tinyGap = checkTransitionManifest({ ...manifest, audios: [{ start: 0, end: 1 }, { start: 1.0000001, end: 20 }] }) as any;
assert.equal(tinyGap.audio_gaps.length, 1, 'sub-millisecond real gaps are facts, not float noise');
const noisyGap = checkTransitionManifest({ ...manifest, audios: [{ start: 0, end: 3 }, { start: 3.0000000000000004, end: 20 }] }) as any;
assert.equal(noisyGap.audio_gaps.length, 0, 'machine arithmetic noise is not a new gap');

const separate = checkTransitionManifest({ fps: 30, total_frames: 360, scenes: [
  { start_frame: 0, end_frame: 30, kind: 'relation', content: [1, 2] },
  { start_frame: 30, end_frame: 60, kind: 'still', content: 2 },
  { start_frame: 60, end_frame: 300, kind: 'video', content: 3 },
  { start_frame: 300, end_frame: 330, kind: 'relation', content: [4, 5] },
  { start_frame: 330, end_frame: 360, kind: 'still', content: 5 },
], audios: [{ start: 0, end: 12, kind: 'voice' }] });
assert.equal(separate.review_groups.length, 2, 'unrelated evidence intervals must not be combined into one giant task');
const audioSnapshot = JSON.stringify(withAudio);
checkTransitionManifest(withAudio);
assert.equal(JSON.stringify(withAudio), audioSnapshot, 'coverage union must not reorder or rewrite input audio');
const before = JSON.stringify(manifest);
const result = checkTransitionManifest(manifest);
assert.deepEqual(result.candidates.map((c) => c.code), ['pause_inserts_picture', 'composition_change']);
assert.equal(result.candidates[0].start_seconds, 3.1);
assert.equal(result.candidates[0].end_seconds, 3.3);
assert.equal(result.status, 'review_required');
assert.equal(result.full_film_accepted, false);
assert.equal(JSON.stringify(manifest), before, 'checking cannot mutate production data');

const hold = structuredClone(manifest);
hold.scenes[0] = { ...hold.scenes[0], kind: 'still', content: 62.2 };
assert.equal(checkTransitionManifest(hold).candidates.length, 0, 'a breath that retains its preceding picture is not an extra shot');
const entry = structuredClone(manifest);
entry.scenes[0] = { ...entry.scenes[0], kind: 'original', content: 43 };
entry.scenes[2] = { ...entry.scenes[2], kind: 'video', content: 62.2 };
assert.equal(checkTransitionManifest(entry).candidates.length, 0, 'pause picture continuing into the next view is not an inserted flash');
const relation = structuredClone(manifest);
relation.scenes[1] = { ...relation.scenes[1], kind: 'video', label: undefined };
assert(checkTransitionManifest(relation).candidates.some((c) => c.code === 'composition_change'));

for (const seconds of [.2, 3, 5, 12]) {
  const control = checkTransitionManifest({ fps: 30, total_frames: 600,
    scenes: [{ start_frame: 0, end_frame: 600, kind: 'video', content: 56 }],
    lines: [{ line_id: 'control', start: 0, end: seconds }] });
  assert.equal(control.status, 'no_mechanical_candidates');
  assert.equal(control.narration_spans[0].duration_seconds, seconds);
  assert.equal(control.semantic_review, 'not_performed', 'seconds cannot prove narration is redundant or useful');
  assert.equal(control.full_film_accepted, false);
}
const arithmeticOnly = { ...hold, lines: [
  { line_id: 'first', start: 0, end: 3.0000000000000004 },
  { line_id: 'second', start: 3, end: 6 },
] };
assert.doesNotThrow(() => checkTransitionManifest(arithmeticOnly));
assert.throws(() => checkTransitionManifest({ ...arithmeticOnly, lines: [
  arithmeticOnly.lines[0], { ...arithmeticOnly.lines[1], start: 2.999999 },
] }), 'real overlap must not be hidden by arithmetic-noise handling');
for (const corrupt of [
  { ...manifest, fps: 0 }, { ...manifest, fps: NaN }, { ...manifest, total_frames: 601 },
  { ...manifest, scenes: [...manifest.scenes].reverse() },
  { ...manifest, scenes: manifest.scenes.map((s, i) => i === 1 ? { ...s, start_frame: 94 } : s) },
  { ...manifest, scenes: manifest.scenes.map((s, i) => i === 1 ? { ...s, start_frame: 92 } : s) },
  { ...manifest, scenes: manifest.scenes.map((s, i) => i === 0 ? { ...s, content: [60.6] } : s) },
  { ...manifest, lines: [{ line_id: 'invalid', start: 2, end: 1 }] },
  { ...manifest, lines: [...manifest.lines, ...manifest.lines] },
  { ...manifest, lines: [{ line_id: 'invalid', start: 0, end: 21 }] },
]) assert.throws(() => checkTransitionManifest(corrupt));
console.log('transition candidates: inserted-pause regression, retained-picture/entry controls, duration controls, invalid inputs and no-mutation checks passed; no model calls');
