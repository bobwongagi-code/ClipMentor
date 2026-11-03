import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp, { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fixture from './fixtures/blueprint-self-check-cases.json';
import type { ProjectDoc } from '../editor/types';
import { lintBlueprint, repeatedRootCandidates, calibrateSpeech } from './blueprint-lint';
import { copyTeachingPacketFromDoc, buildCopyTeachingReviewRequest } from './production-gate';
import { checkBlueprintFiles } from '../../server/clipmentor/blueprint-check.mts';

const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const gm = fixture.cases.find(c => c.id === 'GM-v1')!;
const before = JSON.stringify(fixture);
// Archive provenance is checked when running in the author workspace. Packaged
// fixtures remain usable without local production records, with no network fetch.
const available = fixture.sources.map(s => fs.existsSync(resolve('..', s.path)));
assert(available.every(Boolean) || available.every(x => !x), 'partial archive cannot silently skip provenance');
if (available.every(Boolean)) {
  for (const source of fixture.sources) assert.equal(hash(fs.readFileSync(resolve('..', source.path))), source.sha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(resolve('..', gm.source), 'utf8')), gm.input);
  const source = JSON.parse(fs.readFileSync(resolve('..', fixture.isolation_project.source), 'utf8'));
  assert.equal(hash(fs.readFileSync(resolve('..', fixture.isolation_project.source))), fixture.isolation_project.source_sha256);
  const projected = fixture.isolation_project.doc;
  for (const asset of projected.assets) assert.deepEqual(asset, source.assets.find((a: { id: string }) => a.id === asset.id));
  assert.deepEqual(projected.timelines, source.timelines);
  for (const [key, value] of Object.entries(projected.clipMentorAnalysis)) {
    if (key !== 'blueprint') assert.deepEqual(value, source.clipMentorAnalysis[key]);
  }
  for (const unit of projected.clipMentorAnalysis.blueprint) {
    const original = source.clipMentorAnalysis.blueprint.find((u: { unit_id: string }) => u.unit_id === unit.unit_id);
    for (const [key, value] of Object.entries(unit)) if (key !== 'internal_review') assert.deepEqual(value, original[key]);
    for (const [key, value] of Object.entries(unit.internal_review)) assert.deepEqual(value, original.internal_review[key]);
  }
}
for (const c of fixture.cases) if (c.markdown) assert.equal(hash(c.markdown.text), c.markdown.sha256);
for (const c of fixture.checks) {
  const input = fixture.cases.find(x => x.id === c.case_id)!.input;
  const value = c.source_pointer.split('/').slice(1).reduce((v: any, key) => v[key], input);
  assert.equal(value, c.excerpt, 'real failure excerpt must retain its actual source pointer');
}
let checks = 0;
const report = lintBlueprint(gm.input);
const hit = (rule: string, r = report) => r.findings.filter(f => f.rule_id === rule);
for (const id of ['B02', 'B03', 'B04', 'B06']) { assert(hit(id).length > 0, `real source ${id}`); checks++; }
assert(hit('B02').some(f => f.location === 'GM-OPEN'));
assert(hit('B04').some(f => f.location === 'GM-CTA-new' && f.excerpt.includes('RM20,000'))); checks++;
// Preserve differences between the original and the specification's expectations.
assert(gm.markdown);
assert.equal(hit('B09', lintBlueprint(gm.input, { markdown: { text: gm.markdown.text, references: [] } })).length, 0);
assert.equal(hit('B01').length, 0, 'quoted ellipses are not doubled Chinese punctuation');
assert.equal(hit('B07').length, 0, 'disjoint montage actions cannot be equated by source coordinates');
assert.equal(hit('B05').filter(f => f.level === 'warn').length, 0, 'G4 uncertainty overlaps available duration'); checks++;
assert(report.groups.find(g => g.group_id.startsWith('GM-G4'))!.estimated_seconds! > 10.5); checks++;
assert.equal(report.calibration.sample_count, 9);
assert.deepEqual(new Set(report.calibration.samples.map(s => s.product)), new Set(['Barely There', 'Teashell']));
assert(report.calibration.samples.every(s => Number.isFinite(s.leave_one_out_error_seconds)));
assert.equal(calibrateSpeech([]).words_per_second, null);
assert(lintBlueprint(gm.input, { samples: [] }).durations.every(d => d.estimated_total_seconds === null)); checks++;

// These controls are explicitly synthetic and never overwrite the real cases.
const synthetic = (text: string, labels: string[] = []) => ({ narration_and_captions: { lines: [{ id: 's', narration_ms: text, zh: '测试', labels }] },
  estimated_picture_timeline: { fps: 30, rows: [{ row_id: 'g', mode_order: ['original', 'explanation'], original_source_seconds: [0, 0.1], line_ids: ['s'] }] } });
for (const text of ['句末。。', 'two.. stops', '，，', ' trim ']) assert(hit('B01', lintBlueprint(synthetic(text))).length); checks++;
for (const text of ['Quoted words... then more...', 'A single sentence.']) assert.equal(hit('B01', lintBlueprint(synthetic(text))).length, 0); checks++;
assert(hit('B05', lintBlueprint(synthetic('Ini ialah contoh panjang yang perlu dibaca dengan suara biasa.'))).some(f => f.level === 'warn')); checks++;
const overlap = { estimated_picture_timeline: { fps: 30, rows: [
  { kind: 'original', source_asset_id: 'a', source_frames: [0, 300] }, { kind: 'explanation', source_asset_id: 'a', source_frames: [60, 240] },
  { kind: 'explanation', source_asset_id: 'a', source_frames: [120, 180] }, { kind: 'explanation', source_asset_id: 'b', source_frames: [120, 180] },
] } };
assert.deepEqual(lintBlueprint(overlap).reuse.map(r => [r.asset, r.range, r.count]), [['a', [4, 6], 3]]); checks++;
assert.equal(lintBlueprint({ estimated_picture_timeline: { rows: [{ kind: 'explanation', source_frames: [0, 30] }] } }).reuse.length, 0); checks++;
for (const [spoken, label] of [ ['Komisen sebelas peratus.', 'Komisen 11%'], ['Ada tiga warna.', '3 warna'],
  ['Bajet dua puluh ribu ringgit.', 'RM20,000'], ['Lima perpuluhan tujuh tujuh juta tontonan.', '5.77 juta'] ])
  assert.equal(hit('B04', lintBlueprint(synthetic(spoken, [label]))).length, 0, `written/spoken quantity ${label}`); checks++;
assert(hit('B04', lintBlueprint(synthetic('Ada sebelas produk.', ['Komisen 11%']))).length); checks++;
const screen = synthetic('Hubungi kami.'); (screen.narration_and_captions.lines[0] as any).picture = { overlay: { text: 'RM20,000' }, crop: [0, 0, 11, 20] };
assert.equal(hit('B04', lintBlueprint(screen)).length, 1); checks++;
assert.equal(hit('B09', lintBlueprint(synthetic('Ini ayat.'), { markdown: { text: '', references: [{ reference: 'missing.json', exists: false }] } })).length, 3);
assert.equal(hit('B09', lintBlueprint(synthetic('Ini ayat.'), { markdown: { text: 'Ini ayat. 测试', references: [] } })).length, 0); checks++;
const hold = { clipMentorAnalysis: { source: { fps: 30 }, blueprint: [{ unit_id: 'hold', internal_review: {
  current_script_candidate: 'copy', current_picture_plan: 'plan', copy: { lines: [{ id: 'l', narration_ms: 'Hubungi kami.' }] },
  plan: { phases: [{ mode: 'original', source_range_seconds: [0, 1] },
    { mode: 'explanation', line_id: 'l', source_range_seconds: [1, 1], duration_frames: 15, overlay: { text: 'RM20,000' } }] },
} }] } };
assert.equal(lintBlueprint(hold).groups[0].picture_seconds, 0.5);
assert(hit('B04', lintBlueprint(hold)).some(f => f.excerpt === 'RM20,000')); checks++;
const unknownLine = synthetic('Ini ayat.'); unknownLine.estimated_picture_timeline.rows[0].line_ids.push('absent');
assert(lintBlueprint(unknownLine).groups.every(g => !g.complete)); checks++;

// B08 pilot counts known useful pairs vs candidates on frozen accepted copy.
const negativeCases = fixture.cases.filter(c => fixture.root_repeat_evaluation.negative_case_ids.includes(c.id));
const uniqueLines = new Map<string, { text: string; case_ids: string[] }>();
for (const c of negativeCases) {
  const input: any = c.input;
  const current = (input.clipMentorAnalysis?.blueprint ?? []).flatMap((u: any) => { const ir = u.internal_review; return ir?.[ir.current_script_candidate]?.lines ?? []; });
  for (const l of [...input.narration_and_captions ?? [], ...current]) if (l.narration_ms) {
    const old = uniqueLines.get(l.narration_ms); if (old) old.case_ids.push(c.id); else uniqueLines.set(l.narration_ms, { text: l.narration_ms, case_ids: [c.id] });
  }
}
const falsePositives = [...uniqueLines.values()].flatMap(l => repeatedRootCandidates(l.text).map(candidate => ({ ...l, candidate })));
const truePositives = repeatedRootCandidates(fixture.root_repeat_evaluation.positive.excerpt).filter(c => c.root === 'tunjuk');
assert.equal(truePositives.length, 1); assert(falsePositives.length > truePositives.length);
assert(falsePositives.some(p => p.candidate.root === 'nampak'));
assert(fixture.cases.every(c => !lintBlueprint(c.input).findings.some(f => f.rule_id === 'B08'))); checks++;
for (const c of negativeCases) {
  // The saved project includes a later opening/CTA; A3 asks about the four-group
  // body, not those added delivery sections. Do not conceal their real warnings.
  const scoped: any = structuredClone(c.input);
  if (c.id === 'BT-four-group-current') {
    assert(hit('B02', lintBlueprint(c.input)).length > 0, 'real registered opening digits must now be inspected');
    for (const u of scoped.clipMentorAnalysis.blueprint) {
      const ir = u.internal_review; delete ir[ir.current_picture_plan].delivery_sections;
    }
  }
  const r = lintBlueprint(scoped);
  for (const id of ['B01', 'B02', 'B04']) assert.equal(hit(id, r).length, 0, `accepted body ${c.id} ${id}`);
  assert.equal(hit('B05', r).filter(f => f.level === 'warn').length, 0);
  assert(c.markdown, `actual text view missing for ${c.id}`);
  assert.equal(hit('B09', lintBlueprint(scoped, { markdown: { text: c.markdown.text, references: [] } })).length, 0); checks++;
}

// A6 exercises both existing projection boundaries; no production changes.
const baseline = await copyTeachingPacketFromDoc(structuredClone(fixture.isolation_project.doc) as unknown as ProjectDoc);
const annotated: any = structuredClone(fixture.isolation_project.doc), marker = 'SELF_CHECK_PRIVATE_ORACLE_MUST_NOT_LEAK';
annotated.delivery_record = { author_self_check: marker, mechanical_lint: { input_sha256: marker, findings: report.findings }, remaining_gaps: [{ source: marker }] };
annotated.clipMentorAnalysis.delivery_record = { '作者自检': marker };
for (const u of annotated.clipMentorAnalysis.blueprint) { u.author_self_check = marker; u.internal_review.author_self_check = marker; }
const packet: any = await copyTeachingPacketFromDoc(annotated);
assert.deepEqual(packet, baseline);
const marked: any = structuredClone(packet);
marked.delivery_record = { author_self_check: marker };
for (const u of marked.units) { u.author_self_check = marker; for (const l of u.lines) l.author_self_check = marker; u.picture_plan.execution_plan.content.author_self_check = marker; }
const projected = buildCopyTeachingReviewRequest([{ case_id: 'current-material', packet: marked }]);
assert(!JSON.stringify(projected).includes(marker));
assert.deepEqual(projected, buildCopyTeachingReviewRequest([{ case_id: 'current-material', packet: baseline }])); checks++;

const dir = await mkdtemp(join(tmpdir(), 'blueprint-lint-'));
const oldFetch = globalThis.fetch;
let networkCalls = 0, writes = 0;
const restore: Array<() => void> = [];
try {
  const json = join(dir, 'candidate.json'), md = join(dir, 'view.md');
  await writeFile(json, JSON.stringify(gm.input));
  const input: any = gm.input;
  const texts = [...input.narration_and_captions, input.delivery_sections.opening, ...Object.values(input.delivery_sections.creator_endings)];
  await writeFile(md, texts.map((l: any) => `${l.narration_ms}\n${l.zh}`).join('\n') + '\n[candidate](candidate.json)');
  const initial = hash(await readFile(json));
  globalThis.fetch = async () => { networkCalls++; throw new Error('No network'); };
  // Trap filesystem mutations only while the actual checker is running.
  for (const target of [fs, fsp]) for (const key of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'truncate', 'truncateSync', 'createWriteStream']) {
    const t = target as any, original = t[key]; if (typeof original !== 'function') continue;
    t[key] = () => { writes++; throw new Error('No writes'); }; restore.push(() => { t[key] = original; });
  }
  syncBuiltinESMExports();
  const checked = await checkBlueprintFiles([json, '--md', md]);
  assert.equal(checked.findings.filter(f => f.rule_id === 'B09').length, 0);
  assert.equal(hash(await readFile(json)), initial);
  assert.equal((await checkBlueprintFiles([join(dir, 'missing.json')])).findings[0].rule_id, 'INPUT');
  assert.equal(writes, 0); assert.equal(networkCalls, 0); checks++;
} finally {
  for (const fn of restore.reverse()) fn(); syncBuiltinESMExports(); globalThis.fetch = oldFetch;
  await rm(dir, { recursive: true, force: true });
}
const cli = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/clipmentor/blueprint-check.mts', '/not-a-real-candidate.json'], { cwd: resolve('.') }).toString();
assert.equal(JSON.parse(cli).findings[0].rule_id, 'INPUT'); checks++;
assert.equal(JSON.stringify(fixture), before);
console.log(JSON.stringify({ checks, real_model_calls: 0, network_calls: networkCalls, writes_during_check: writes,
  A2: { matched: ['B02', 'B03', 'B04'], not_reproduced: ['B01: absent', 'B05: uncertainty overlaps', 'B07: montage identity unavailable', 'B09: source exists; compare real view separately'] },
  B08: { enabled: false, unique_accepted_lines: uniqueLines.size, known_true_positive_pairs: truePositives.length, false_positive_candidates: falsePositives.length, false_positives: falsePositives },
  calibration: report.calibration }, null, 2));

// Saved v3/v4 regressions: questions locate real prose, never certify pixels.
const boardCases = (await import('./fixtures/blueprint-picture-inputs-20261103.json')).default.cases;
const v4Fixture = (await import('./fixtures/blueprint-picture-v4-20261103.json')).default;
const portableCases = (await import('./fixtures/blueprint-picture-inputs-20261103.json')).default;
const assertSavedSubset = (projection: unknown, source: unknown): void => {
  if (projection !== null && typeof projection === 'object') {
    assert(source !== null && typeof source === 'object');
    if (Array.isArray(projection)) { assert(Array.isArray(source)); assert.equal(projection.length, source.length); }
    for (const [key, value] of Object.entries(projection)) { assert(Object.hasOwn(source, key)); assertSavedSubset(value, (source as Record<string, unknown>)[key]); }
  } else assert.equal(projection, source);
};
for (const [key, provenance] of Object.entries(portableCases.provenance)) {
  const sourcePath = resolve('..', provenance.source);
  if (fs.existsSync(sourcePath)) {
    const bytes = fs.readFileSync(sourcePath); assert.equal(hash(bytes), provenance.sha256);
    assertSavedSubset(portableCases.cases[key as keyof typeof portableCases.cases], JSON.parse(bytes.toString('utf8')));
  }
}

const pictureFindings = (input: unknown) => lintBlueprint(input).findings.filter(f => f.rule_id === 'B10' || f.rule_id === 'B11');
const v3Pictures = pictureFindings(boardCases.green);
assert(v3Pictures.some(f => f.rule_id === 'B10' && f.excerpt.includes('源帧21') && f.location.includes('.phases[1].picture')));
assert(v3Pictures.some(f => f.rule_id === 'B11' && f.excerpt.includes('三色')));
assert(v3Pictures.every(f => f.level === 'notice'));
assert.equal(pictureFindings(v4Fixture.input).length, 0, 'valid different original/revisit windows and distinct roles are not conflicts');
const v4Source = resolve('..', v4Fixture.source);
if (fs.existsSync(v4Source)) {
  assert.equal(hash(fs.readFileSync(v4Source)), v4Fixture.source_sha256);
  const original = JSON.parse(fs.readFileSync(v4Source, 'utf8'));
  for (const u of v4Fixture.input.clipMentorAnalysis.blueprint) {
    const source = original.clipMentorAnalysis.blueprint.find((s: any) => s.unit_id === u.unit_id);
    for (const [key, value] of Object.entries(u.internal_review)) assert.deepEqual(value, source.internal_review[key]);
  }
}
const { blueprintPictureNotices } = await import('./blueprint-picture-notices');
const pictureRow = { key: 'a', unit_id: 'u', stage: 'explanation', line_ids: ['L1'], range: [0, 3] as [number, number], picture: '只用源帧21', location: '$.a' };
assert.equal(blueprintPictureNotices([pictureRow]).length, 1);
assert.equal(blueprintPictureNotices([{ ...pictureRow, range: [0.7, 0.7] }]).length, 0, 'declared still does not pretend to be a broad range');
assert.equal(blueprintPictureNotices([{ ...pictureRow, stage: 'original' }]).length, 0, 'original context is not a revisit task');
const dynamic = { ...pictureRow, picture: '正常速度动态展示' };
assert.equal(blueprintPictureNotices([dynamic, { ...dynamic, key: 'b', stage: 'original', line_ids: [] }]).length, 0);
assert.equal(blueprintPictureNotices([dynamic, { ...dynamic, key: 'b', line_ids: ['L2'] }]).filter(f => f.rule_id === 'B11').length, 1);
assert.equal(blueprintPictureNotices([dynamic, { ...dynamic, key: 'b' }]).length, 0, 'same line continued across phases is not two copied line tasks');
assert.equal(blueprintPictureNotices([{ ...dynamic, picture: '' }, { ...dynamic, key: 'b', line_ids: ['L2'], picture: '' }]).length, 0);
const hashDir = await mkdtemp(join(tmpdir(), 'blueprint-input-identity-'));
try {
  const input = join(hashDir, 'blueprint.json'), bytes = JSON.stringify(v4Fixture.input, null, 2);
  await writeFile(input, bytes);
  const checked = await checkBlueprintFiles([input]);
  assert.equal('input_sha256' in checked ? checked.input_sha256 : null, hash(bytes));
  await writeFile(input, bytes + '\n');
  const changed = await checkBlueprintFiles([input]);
  assert.equal('input_sha256' in changed ? changed.input_sha256 : null, hash(bytes + '\n'));
  assert.notEqual('input_sha256' in changed ? changed.input_sha256 : null, 'input_sha256' in checked ? checked.input_sha256 : null);
} finally { await rm(hashDir, { recursive: true, force: true }); }
console.log('PASS shared picture notices: saved v3 risks / v4 controls / role boundaries / input hash');
