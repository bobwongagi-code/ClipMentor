import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ProjectDoc, TimelineItem } from '../editor/types';
import { checkSourceBreakdown } from './source-breakdown';
import { checkCopyProduction } from './production-gate';

export async function verifyRegisteredGroupPlayback(base: ProjectDoc, legacyLineId: string) {
  // Actual saved four-group registration must cross both the project ledger and
  // reviewer projection, not just validate an already-projected review packet.
  const groupedRegistration = JSON.parse(readFileSync(new URL('./fixtures/grouped-registration-v1.json', import.meta.url), 'utf8')) as ProjectDoc;
  const { prepareProductionBlueprint } = await import('../../server/clipmentor/production-readiness');
  const { lintBlueprint } = await import('./blueprint-lint');
  const registeredPhase = (doc: ProjectDoc) => {
    const internal = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
    return internal[internal.current_picture_plan].phases[0];
  };
  for (const [field, value, code] of [
    ['kind', 'original', 'picture_plan_phase_field_unsupported:kind'],
    ['source_seconds', [0, 1], 'picture_plan_phase_source_range_conflict'],
  ] as const) {
    const divergent = structuredClone(groupedRegistration);
    registeredPhase(divergent)[field] = value;
    assert(lintBlueprint(divergent).findings.some(finding => finding.rule_id === 'PLAN_STRUCTURE' && finding.message === code));
    await assert.rejects(prepareProductionBlueprint(divergent), new RegExp(code));
  }
  const {default: phaseHistory}=await import('./fixtures/production-saved-projects-20261028.json');
  for(const saved of phaseHistory.cases){
    const historical=saved.doc as unknown as ProjectDoc;
    await prepareProductionBlueprint(historical);
    const malformed=structuredClone(historical);
    for(const unit of malformed.clipMentorAnalysis!.blueprint){
      const internal=(unit as any).internal_review;
      for(const phase of internal[internal.current_picture_plan].phases)phase.mode='misspelled';
    }
    assert(lintBlueprint(malformed).findings.some(finding=>finding.rule_id==='INPUT'&&finding.message.includes('Unknown or missing picture stage')));
    await assert.rejects(prepareProductionBlueprint(malformed),/picture_plan_phase_mode_invalid/);
  }
  const matchingAliases = structuredClone(groupedRegistration);
  registeredPhase(matchingAliases).source_seconds = registeredPhase(matchingAliases).source_range_seconds;
  assert(!lintBlueprint(matchingAliases).findings.some(finding => finding.rule_id === 'PLAN_STRUCTURE'));
  await prepareProductionBlueprint(matchingAliases);

  assert.equal(checkSourceBreakdown(groupedRegistration).status, 'structurally_ready', 'four groups must not acquire a fictitious full-playback-first revisit');
  const preparedGroup = await prepareProductionBlueprint(groupedRegistration);
  assert.equal((preparedGroup.packet.units[0].picture_plan!.execution_plan!.content.phases as unknown[]).length, 9);
  assert.equal(preparedGroup.packet.units[0].picture_plan!.registered_revisits.length, 5);
  assert.equal((await checkCopyProduction(groupedRegistration, 'clipmentor')).allowed, false, 'valid grouped structure never replaces independent production approval');
  const groupedSubwindow = structuredClone(groupedRegistration);
  const subAnalysis = groupedSubwindow.clipMentorAnalysis!;
  const subLedger = subAnalysis.source_breakdown!;
  const subUnit = subLedger.units[0];
  const firstRevisit = subUnit.revisits[0];
  const sourceAnchor = subLedger.segments.find(segment => segment.segment_id === firstRevisit.from_segment_id)!;
  subLedger.segments.push({ ...sourceAnchor, segment_id: 'combined-playback-anchor', source_range_seconds: [0, 5],
    visible_evidence_ids: [], claim_evidence_ids: [], interpretation_evidence_ids: [] });
  subAnalysis.evidence.push({ evidence_id: 'anchor-frame', kind: 'source_frame', text: 'Local fixture frame', status: 'fixture',
    source_ids: [], supporting_evidence_ids: [], source_frame: 30, time_seconds: 1, observation_method: 'fixture', call_status: 'succeeded' });
  subLedger.segments.at(-1)!.visible_evidence_ids.push('anchor-frame');
  subUnit.original_segment_ids.push('combined-playback-anchor');
  firstRevisit.from_segment_id = 'combined-playback-anchor';
  const subInternal = (subAnalysis.blueprint[0] as any).internal_review;
  subInternal[subInternal.current_picture_plan].phases[1].source_range_seconds = [1, 4];
  assert.deepEqual((await prepareProductionBlueprint(groupedSubwindow)).packet.units[0].picture_plan!.registered_revisits[0],
    { from_source_range: [0, 10.733333333333333], to_source_range: [1, 4] });
  for (const change of [
    (doc: ProjectDoc) => { doc.clipMentorAnalysis!.source_breakdown!.units[0].revisits[0].from_segment_id = 'BT-G2-original'; },
    (doc: ProjectDoc) => { const ir = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review; ir[ir.current_picture_plan].phases[1].source_range_seconds = [1, 10.5]; },
  ]) {
    const invalid = structuredClone(groupedSubwindow); change(invalid);
    assert(checkSourceBreakdown(invalid).issues.some(issue => issue.code === 'picture_plan_revisits_mismatch'));
    await assert.rejects(prepareProductionBlueprint(invalid));
  }
  const gInternal = (groupedRegistration.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  for (const change of [
    (doc: ProjectDoc) => { doc.clipMentorAnalysis!.source_breakdown!.units[0].revisits.pop(); },
    (doc: ProjectDoc) => { doc.clipMentorAnalysis!.source_breakdown!.units[0].original_source_ranges!.reverse(); },
    (doc: ProjectDoc) => { const i = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review; i[i.current_picture_plan].phases[1].line_id = 'missing'; },
    (doc: ProjectDoc) => { const i = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review; i[i.current_picture_plan].phases.splice(1, 1); },
    (doc: ProjectDoc) => { const i = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review; i[i.current_picture_plan].phases.pop(); },
    (doc: ProjectDoc) => { const i = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review; i[i.current_picture_plan].phases[0].mode = ['original']; },
    (doc: ProjectDoc) => { const i = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review; delete i[i.current_picture_plan].viewer_stage_cues; },
  ] ) {
    const invalid = structuredClone(groupedRegistration); change(invalid);
    await assert.rejects(prepareProductionBlueprint(invalid), 'invalid phases, cues and missing revisits must still block the actual product entry');
  }
  const artificialRevisit = structuredClone(groupedRegistration);
  artificialRevisit.clipMentorAnalysis!.source_breakdown!.units[0].revisits.push({
    from_segment_id: 'BT-G4-original', to_segment_id: 'BT-explanation-BT-L01', reason: 'This full-first revisit is absent from the actual phases',
  });
  await assert.rejects(prepareProductionBlueprint(artificialRevisit), 'an extra invented revisit cannot satisfy the ledger at the expense of the real phase plan');
  assert.equal(gInternal[gInternal.current_picture_plan].phases.length, 9, 'preparation does not mutate the frozen plan');

  // Reproduce the actual export gate, not only the preparation projection: the
  // old checker accepted grouped phases but still required every original first.
  const groupedTimeline = structuredClone(groupedRegistration);
  const gt = groupedTimeline.timelines.find(t => t.id === groupedTimeline.activeTimelineId)!;
  const gi = (groupedTimeline.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  const gp = gi[gi.current_picture_plan];
  const sourceId = groupedTimeline.clipMentorAnalysis!.source.asset_id;
  const rows: any[] = [];
  let cursor = 0;
  for (const [index, phase] of gp.phases.entries()) {
    const source = phase.source_range_seconds.map((n: number) => Math.round(n * gt.fps));
    // A phase can span multiple adjacent clips (as the saved L03 does).
    const cuts = index === 5 ? [source[0], source[0] + 60, source[1]] : source;
    for (let part = 0; part < cuts.length - 1; part++) {
      const length = cuts[part + 1] - cuts[part];
      rows.push({ row_id: `phase-${index}-${part}`, unit_id: 'BT-U01', kind: phase.mode,
        source_asset_id: sourceId, source_frames: [cuts[part], cuts[part + 1]],
        output_frames_reference: [cursor, cursor + length], line_ids: phase.line_id ? [phase.line_id] : [] });
      cursor += length;
    }
  }
  function installRows(doc: ProjectDoc, selected: any[]) {
    const sourceId = doc.clipMentorAnalysis!.source.asset_id;
    const internal = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
    internal[internal.current_picture_plan].composition.detail = JSON.stringify({ production_rows: selected });
    const timeline = doc.timelines.find(t => t.id === doc.activeTimelineId)!;
    timeline.items = selected.map((r, i) => ({ id: `grouped-item-${i}`, kind: 'video', track: 'V1',
      sourceAssetId: sourceId, src: doc.assets.find(a => a.id === sourceId)!.src,
      startFrame: r.output_frames_reference[0], durationInFrames: r.output_frames_reference[1] - r.output_frames_reference[0],
      srcInFrame: r.source_frames[0], playbackRate: 1, volume: r.kind === 'original' ? 1 : 0 } as TimelineItem));
  }
  installRows(groupedTimeline, rows);
  assert.equal(checkSourceBreakdown(groupedTimeline, true).status, 'structurally_ready',
    'the export checker must accept four original/explanation groups, including split explanation rows');
  assert.equal((await checkCopyProduction(groupedTimeline, 'clipmentor')).allowed, false,
    'valid timeline order never fabricates production approval');
  function reorderedRows(order: any[]) {
    let start = 0;
    return order.map(r => { const length = r.output_frames_reference[1] - r.output_frames_reference[0];
      const next = { ...structuredClone(r), output_frames_reference: [start, start + length] }; start += length; return next; });
  }
  for (const [label, order] of [
    ['explanation before its original', [rows[1], rows[0], ...rows.slice(2)]],
    ['all originals before all explanations', [...rows.filter(r => r.kind === 'original'), ...rows.filter(r => r.kind === 'explanation')]],
    ['explanation in another group', [rows[0], rows[3], rows[2], rows[1], ...rows.slice(4)]],
    ['G4 line order reversed', [...rows.slice(0, -2), rows.at(-1), rows.at(-2)]],
    ['original groups swapped', [rows[2], rows[1], rows[0], ...rows.slice(3)]],
  ] as Array<[string, any[]]>) {
    const bad = structuredClone(groupedTimeline); installRows(bad, reorderedRows(order));
    assert(checkSourceBreakdown(bad, true).issues.some(i => i.code === 'unit_output_order_invalid'), label);
  }
  const groupedMissing = structuredClone(groupedTimeline);
  groupedMissing.timelines.find(t => t.id === gt.id)!.items.pop();
  assert(checkSourceBreakdown(groupedMissing, true).issues.some(i => i.code === 'timeline_plan_picture_missing'));

  // line_ids are references, not a second playback-order declaration. One clip
  // can carry adjacent lines; order must follow phases and its covered intervals.
  const sharedLastRow = { ...structuredClone(rows.at(-2)!), line_ids: ['BT-L04', 'BT-L06'] };
  const returnedLine = structuredClone(groupedTimeline);
  installRows(returnedLine, reorderedRows([...rows.slice(0, -2), sharedLastRow,
    { ...structuredClone(sharedLastRow), row_id: 'return-earlier-line', line_ids: ['BT-L04'] }]));
  assert(checkSourceBreakdown(returnedLine, true).issues.some(i => i.code === 'unit_output_order_invalid'),
    'a shared row cannot conceal the earlier line continuing after the later line has finished');

  for (const ids of [['BT-L04', 'BT-L06'], ['BT-L06', 'BT-L04']]) {
    const shared = structuredClone(groupedTimeline);
    installRows(shared, reorderedRows([...rows.slice(0, -2), { ...sharedLastRow, line_ids: ids }]));
    assert.equal(checkSourceBreakdown(shared, true).status, 'structurally_ready', 'shared picture reference order cannot change playback order');
  }
  const splitOriginal = structuredClone(groupedTimeline);
  const first = rows[0];
  installRows(splitOriginal, reorderedRows([
    { ...structuredClone(first), source_frames: [first.source_frames[0], 150], output_frames_reference: [0, 150] },
    { ...structuredClone(first), row_id: 'original-split-tail', source_frames: [150, first.source_frames[1]], output_frames_reference: [150, first.output_frames_reference[1]] },
    ...rows.slice(1),
  ]));
  assert.equal(checkSourceBreakdown(splitOriginal, true).status, 'structurally_ready', 'contiguous split original clips are still one group');
  for (const missing of [0, 3, 7, 9]) {
    const incomplete = structuredClone(groupedTimeline);
    installRows(incomplete, reorderedRows(rows.filter((_, i) => i !== missing)));
    assert.notEqual(checkSourceBreakdown(incomplete, true).status, 'structurally_ready', 'missing planned group/line must block: ' + missing);
  }
  const legacyRows = structuredClone(base);
  const li = (legacyRows.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  li.current_picture_plan = 'picture_plan_legacy_rows';
  li.picture_plan_legacy_rows = { script_candidate_id: 'copy', composition: { detail: '' } };
  legacyRows.clipMentorAnalysis!.source_breakdown!.units[0].placement = { timeline_id: 'tl', original_frames: [0, 84], explanation_frames: [84, 168] };
  const oldRows = ['original', 'explanation'].map((kind, i) => ({ row_id: `legacy-${kind}`, unit_id: 'U1', kind,
    source_asset_id: 'source', source_frames: [1782, 1866], output_frames_reference: [84 * i, 84 * (i + 1)],
    line_ids: i ? [legacyLineId] : [] }));
  installRows(legacyRows, oldRows);
  assert.equal(checkSourceBreakdown(legacyRows, true).status, 'structurally_ready', 'legacy all-original-then-explanation stays valid');
  installRows(legacyRows, reorderedRows([...oldRows].reverse()));
  assert(checkSourceBreakdown(legacyRows, true).issues.some(i => i.code === 'unit_output_order_invalid'), 'legacy reversed order still blocks');
}
