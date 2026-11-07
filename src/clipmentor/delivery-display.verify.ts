// Zero providers. The real saved failure is replayed in memory; no production
// plan or receipt is upgraded by these test-only display bindings.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import saved from '../agent/tools/fixtures/barely-there-bookend-replacement-20261029.json';
import type { ProjectDoc } from '../editor/types';
import {
  assertDeliveryPicturePreservation, deliverySectionsFromDoc, deliverySectionsShape,
  deliveryTimeline, deliveryPictureBinding, deliveryPictureBindings, type DeliverySection,
} from './delivery-sections';
import {
  copyReviewSubject, copyTeachingPacketFromDoc, checkCopyProduction,
  buildCopyTeachingReviewRequest,
} from './production-gate';
import { reviewClipMentorCopy, type CopyReviewDependencies } from '../../server/clipmentor/copy-review';

const base = structuredClone(saved.before) as unknown as ProjectDoc;
const timeline = (d: ProjectDoc) => d.timelines.find(t => t.id === d.activeTimelineId)!;
const plan = (d: ProjectDoc) => {
  const ir = (d.clipMentorAnalysis!.blueprint[0] as unknown as { internal_review: Record<string, unknown> }).internal_review;
  return ir[String(ir.current_picture_plan)] as { delivery_sections: DeliverySection[] };
};
const opening = (d: ProjectDoc) => plan(d).delivery_sections.find(s => s.kind === 'performance_opening')!;
const picture = (d: ProjectDoc) => timeline(d).items.find(i => i.kind === 'image' && i.sourceAssetId === opening(d).picture.asset_id)!;
const setDisplay = (d: ProjectDoc, ranges: number[][] = [[0, 157]], fps = 30) => {
  Object.assign(opening(d).picture, { display: { fps, ranges } });
  return d;
};
// Synthetic matching review binding for isolated save-guard cases only.
// The final service test below exercises actual receipt validation separately.
const withTestBinding = (d: ProjectDoc) => {
  const receipt = d.clipMentorAnalysis!.production_copy_review!;
  receipt.analysis_revision = d.clipMentorAnalysis!.revision;
  receipt.teaching_review!.packet.delivery_sections = structuredClone(plan(d).delivery_sections);
  return d;
};
const phased = () => withTestBinding(setDisplay(structuredClone(base)));
const ready = (d: ProjectDoc) => deliveryTimeline(d, [opening(d)]).issues;
const checks: string[] = [], failures: string[] = [];
async function check(name: string, work: () => void | Promise<void>) {
  if (process.env.PHASE_CASE && process.env.PHASE_CASE !== name) return;
  try { await work(); checks.push(name); console.log('PASS ' + name); }
  catch (e) { failures.push(name); console.error(`FAIL ${name}: ${String(e)}`); }
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network forbidden in display-contract verification'); };
try {
  await check('layered-opening-requires-original-matte-and-exit', () => {
    const d=phased(),t=timeline(d),s=opening(d),photo=picture(d),source=t.items.find(i=>i.kind==='video')!;
    const a=d.assets.find(a=>a.id===source.sourceAssetId)!;
    const [top,middle,lower]=t.trackOrder!;
    s.picture.layout={kind:'original_underlay',source:{asset_id:a.id,src:a.src,sha256:a.sourceContentHash!},
      range:[0,10],shade:0.63,show_sales:true,headline:['339k tontonan'],transition:['Jom tengok.']};
    photo.track=top;photo.durationInFrames=157;
    const video={...source,id:'opening-video',track:lower,startFrame:0,srcInFrame:0,durationInFrames:275};
    const matte={id:'opening-matte',kind:'solid' as const,name:'Matte',track:middle,startFrame:0,durationInFrames:275,
      props:{color:'#000000'},transform:{opacity:0.63}};
    t.items.push(video,matte);
    assert.deepEqual(ready(d),[]);
    matte.track=lower;
    assert(ready(d).includes('delivery_opening_original_underlay_or_matte_missing'));
    matte.track=middle;photo.durationInFrames=275;
    assert(ready(d).includes('delivery_opening_sales_layer_or_exit_missing'));
  });
  await check('layered-new-contact-needs-both-crops-visible-together', () => {
    const d=structuredClone(base),t=timeline(d),section=plan(d).delivery_sections.find(s=>s.kind==='creator_invitation')!;
    section.section_id='new_contact';
    delete section.picture.crop;
    const product={left:0,top:0,right:0,bottom:0.55},commission={left:0,top:0.65,right:0,bottom:0};
    section.picture.layout={kind:'product_commission',product_crop:product,commission_crop:commission};
    const first=t.items.find(i=>i.kind==='image'&&i.sourceAssetId===section.picture.asset_id)!;
    const crop=(margins:typeof product)=>deliveryPictureBinding(d,{...section,picture:{...section.picture,crop:margins}}).transform_crop;
    const binding=deliveryPictureBindings(d,[section])[0];
    assert.equal(binding.status,'ready');
    if(binding.status!=='ready')throw Error('Expected two execution crops');
    assert.deepEqual(binding.roles?.product.transform_crop,crop(product));
    assert.deepEqual(binding.roles?.commission.transform_crop,crop(commission));
    first.transform={crop:crop(product)};
    const second:typeof first={...first,id:'commission-layer',transform:{crop:crop(commission)}};
    t.items.push(second);
    const issues=()=>deliveryTimeline(d,[opening(d),section]).issues;
    assert.deepEqual(issues(),[]);
    second.startFrame++;
    assert(issues().includes('delivery_new_contact_product_or_commission_missing'));
    second.startFrame--;second.transform={...second.transform,opacity:0.01};
    assert(issues().includes('delivery_new_contact_product_or_commission_missing'));
  });
  await check('frozen ending card must remain a full native image', () => {
    const d=structuredClone(base),t=timeline(d),section=plan(d).delivery_sections.find(s=>s.kind==='creator_invitation')!;
    const native=t.items.find(i=>i.kind==='image'&&i.sourceAssetId===section.picture.asset_id)!;
    section.section_id='new_contact';
    section.picture.layout={kind:'recruitment_card',poster:{asset_id:'fixture-poster',src:'/media/uploads/fixture.png',sha256:'a'.repeat(64)}};
    delete section.picture.crop;
    native.transform=undefined;
    const issues=()=>deliveryTimeline(d,[opening(d),section]).issues;
    assert(!issues().includes('delivery_ending_card_not_preserved:new_contact'));
    for(const transform of [{scale:1.3},{x:1},{crop:{left:0.1,top:0,right:0,bottom:0}},{opacity:0.2}]){
      native.transform=transform;
      assert(issues().includes('delivery_ending_card_not_preserved:new_contact'));
    }
  });
  await check('reference-only assets cannot be proposed as delivery or committed to a timeline',()=>{
    const d=structuredClone(base),s=plan(d).delivery_sections[0]!;
    d.assets.find(a=>a.id===s.picture.asset_id)!.props={clipmentorReferenceOnly:true};
    assert.throws(()=>deliverySectionsFromDoc(d),/reference_only_asset_forbidden/);
    assert.throws(()=>assertDeliveryPicturePreservation(base,d),/reference_only_asset_cannot_enter_timeline/);
  });
  await check('reference-only sources cannot hide inside an ending layout',()=>{
    const d=structuredClone(base),s=plan(d).delivery_sections.find(s=>s.kind==='creator_invitation')!;
    s.section_id='new_contact';delete s.picture.crop;
    const a=d.assets.find(a=>a.id===s.picture.asset_id)!;
    a.width=720;a.height=1280;
    const ref={...structuredClone(a),id:'reference-poster',src:'/media/uploads/reference-only.png',sourceContentHash:'a'.repeat(64),props:{clipmentorReferenceOnly:true}};
    d.assets.push(ref);
    s.picture.layout={kind:'recruitment_card',poster:{asset_id:ref.id,src:ref.src,sha256:ref.sourceContentHash}};
    assert.throws(()=>deliverySectionsFromDoc(d),/reference_only_asset_forbidden/);
  });
  await check('reference-only media is protected by URL and cannot be unmarked in the same edit',()=>{
    const before=structuredClone(base),ref={...structuredClone(before.assets.find(a=>a.kind==='image')!),
     id:'reference-picture',src:'/media/uploads/reference-picture.png',sourceContentHash:'d'.repeat(64),props:{clipmentorReferenceOnly:true}};
    before.assets.push(ref);
    for(const mode of ['path','embedded','unmarked'] as const){
      const after=structuredClone(before),item={...structuredClone(picture(after)),id:'reference-insert'};
      if(mode==='path'){delete item.sourceAssetId;item.src=ref.src;}
      if(mode==='embedded'){item.sourceAssetId='not-a-reference';item.props={code:`<img src="${ref.src}" />`};}
      if(mode==='unmarked'){item.sourceAssetId=ref.id;item.src=ref.src;after.assets.find(a=>a.id===ref.id)!.props={};}
      timeline(after).items.push(item);
      assert.throws(()=>assertDeliveryPicturePreservation(before,after),/reference_only_asset_(?:cannot_enter_timeline|role_cannot_change)/,mode);
    }
    assert.doesNotThrow(()=>assertDeliveryPicturePreservation(before,structuredClone(before)),'unused reference assets can remain for comparison');
    const libraryAlias=structuredClone(before);
    libraryAlias.assets.push({...ref,id:'library-alias',src:'/media/uploads/library-alias.png',props:{}});
    assert.doesNotThrow(()=>assertDeliveryPicturePreservation(before,libraryAlias),'unused library aliases do not require destructive cleanup');
    const usedAlias=structuredClone(libraryAlias);
    timeline(usedAlias).items.push({...structuredClone(picture(usedAlias)),id:'alias-used',sourceAssetId:'library-alias',src:'/media/uploads/library-alias.png',sourceContentHash:ref.sourceContentHash});
    assert.throws(()=>assertDeliveryPicturePreservation(libraryAlias,usedAlias),/reference_only_asset_cannot_enter_timeline/);
    const unmarkedOnly=structuredClone(before);unmarkedOnly.assets.find(a=>a.id===ref.id)!.props={};
    assert.throws(()=>assertDeliveryPicturePreservation(before,unmarkedOnly),/reference_only_asset_role_cannot_change/,
     'unmarking in one save and inserting in a later save cannot bypass the role');
    const similar=structuredClone(before),item={...structuredClone(picture(before)),id:'different-file',src:ref.src+'2'};
    delete item.sourceAssetId;delete item.sourceContentHash;
    timeline(similar).items.push(item);
    assert.doesNotThrow(()=>assertDeliveryPicturePreservation(before,similar),'a filename prefix cannot ban another upload');
  });
  await check('already-saved reference media cannot be exported under an older review',async()=>{
    const d=structuredClone(base),s=plan(d).delivery_sections[0]!;
    d.assets.find(a=>a.id===s.picture.asset_id)!.props={clipmentorReferenceOnly:true};
    assert.equal((await checkCopyProduction(d,'clipmentor')).code,'reference_only_asset_cannot_enter_timeline');
  });
  await check('saved-failure-stays-blocked-without-structured-binding', () => {
    const d = structuredClone(base); picture(d).durationInFrames = 157;
    assert(ready(d).some(i => i.includes('BT-opening-performance')));
    assert.throws(() => assertDeliveryPicturePreservation(base, d));
  });
  await check('reviewed-display-allows-saved-275-to157-trim', () => {
    const before = phased(), after = structuredClone(before);
    picture(after).durationInFrames = 157;
    assertDeliveryPicturePreservation(before, after);
    assert.deepEqual(ready(after), []);
  });
  await check('segmented-native-coverage-is-shared-by-save-and-export', () => {
    const before = phased(), after = structuredClone(before), p = picture(after);
    p.durationInFrames = 70;
    timeline(after).items.push({ ...structuredClone(p), id: 'native-contiguous-tail', startFrame: 70, durationInFrames: 87 });
    assertDeliveryPicturePreservation(before, after); assert.deepEqual(ready(after), []);
  });
  await check('multiple-display-intervals-and-complete-legacy-display', () => {
    const before = withTestBinding(setDisplay(structuredClone(base), [[0, 40], [80, 157]])), after = structuredClone(before), p = picture(after);
    p.durationInFrames = 40;
    timeline(after).items.push({ ...structuredClone(p), id: 'native-later-phase', startFrame: 80, durationInFrames: 77 });
    assertDeliveryPicturePreservation(before, after); assert.deepEqual(ready(after), []);
    assert.deepEqual(ready(structuredClone(base)), [], 'legacy pictures retain the full audio obligation');
  });
  for (const kind of ['missing', 'wrong-asset', 'wrong-src', 'wrong-hash', 'hidden-track', 'transparent', 'gap'] as const) {
    await check('reject-' + kind, () => {
      const before = phased(), after = structuredClone(before), p = picture(after);
      p.durationInFrames = 157;
      if (kind === 'missing') timeline(after).items = timeline(after).items.filter(i => i.id !== p.id);
      if (kind === 'wrong-asset') p.sourceAssetId = 'unreviewed-image';
      if (kind === 'wrong-src') p.src = '/media/uploads/unreviewed.png';
      if (kind === 'wrong-hash') p.sourceContentHash = 'f'.repeat(64);
      if (kind === 'hidden-track') timeline(after).tracks![p.track]!.hidden = true;
      if (kind === 'transparent') p.transform = { opacity: 0 };
      if (kind === 'gap') {
        p.durationInFrames = 70;
        timeline(after).items.push({ ...structuredClone(p), id: 'native-gap', startFrame: 71, durationInFrames: 86 });
      }
      assert(ready(after).length > 0); assert.throws(() => assertDeliveryPicturePreservation(before, after));
    });
  }
  await check('display-does-not-allow-overrun-into-next-phase', () => {
    assert(ready(phased()).length > 0, '275-frame visible image exceeds the declared 157-frame display');
  });
  await check('phase-contract-does-not-forgive-wrong-crop', () => {
    const d = phased(); picture(d).durationInFrames = 157; picture(d).transform = { crop: { left: .1, top: 0, right: 0, bottom: 0 } };
    assert(ready(d).length > 0);
  });
  await check('unreviewed-after-contract-cannot-shrink-preservation', () => {
    const before = structuredClone(base), after = phased(); picture(after).durationInFrames = 157;
    assert.throws(() => assertDeliveryPicturePreservation(before, after));
  });
  await check('unreviewed-before-contract-cannot-shrink-preservation', () => {
    const before = setDisplay(structuredClone(base)), after = structuredClone(before); picture(after).durationInFrames = 157;
    assert.throws(() => assertDeliveryPicturePreservation(before, after));
  });
  await check('failed-or-stale-phase-review-cannot-shrink-preservation', () => {
    for (const kind of ['failed', 'stale', 'missing-delivery-check']) {
      const before = phased(), after = structuredClone(before);
      if (kind === 'failed') before.clipMentorAnalysis!.production_copy_review!.verdict = 'needs_revision';
      else if (kind === 'stale') before.clipMentorAnalysis!.production_copy_review!.analysis_revision--;
      else before.clipMentorAnalysis!.production_copy_review!.delivery_checks = [];
      picture(after).durationInFrames = 157;
      assert.throws(() => assertDeliveryPicturePreservation(before, after));
    }
  });
  await check('existing-incomplete-display-can-be-repaired-in-steps', () => {
    const before = phased(); picture(before).durationInFrames = 100;
    const after = structuredClone(before); picture(after).durationInFrames = 157;
    assertDeliveryPicturePreservation(before, after); assert.deepEqual(ready(after), []);
  });
  await check('audio-anchor-movement-and-native-instance-rebuild', () => {
    const before = phased(), after = structuredClone(before), p = picture(after);
    const audio = timeline(after).items.find(i => i.kind === 'audio' && i.startFrame === 0)!;
    audio.id = 'rebuilt-same-audio'; audio.startFrame += 300;
    p.startFrame += 300; p.durationInFrames = 157;
    assertDeliveryPicturePreservation(before, after);
    p.startFrame = 0; assert.throws(() => assertDeliveryPicturePreservation(before, after));
  });
  await check('phase-display-cannot-delete-other-use-of-same-picture', () => {
    const before = phased(), extra = { ...structuredClone(picture(before)), id: 'independent-picture-use', startFrame: 4000, durationInFrames: 60 };
    timeline(before).items.push(extra);
    const after = structuredClone(before); picture(after).durationInFrames = 157;
    assertDeliveryPicturePreservation(before, after);
    timeline(after).items = timeline(after).items.filter(i => i.id !== extra.id);
    assert.throws(() => assertDeliveryPicturePreservation(before, after));
  });
  await check('other-frame-rate-sequence-keeps-its-own-original-coverage', () => {
    const before = phased(), backup = structuredClone(timeline(before));
    backup.id = 'backup-at-25fps'; backup.fps = 25; before.timelines.push(backup);
    const after = structuredClone(before); picture(after).durationInFrames = 157;
    assertDeliveryPicturePreservation(before, after);
    const other = after.timelines.find(t => t.id === backup.id)!;
    other.items.find(i => i.id === picture(before).id)!.durationInFrames = 157;
    assert.throws(() => assertDeliveryPicturePreservation(before, after));
  });
  await check('phase-display-before-voice-does-not-discard-existing-picture', () => {
    const before = phased(); before.assets = before.assets.filter(a => a.id !== 'df52e6df-1554-4153-a6c8-a25e8e93f45e');
    const after = structuredClone(before); picture(after).durationInFrames = 157;
    assert.throws(() => assertDeliveryPicturePreservation(before, after));
  });
  for (const display of [null, {}, { fps: 30, ranges: [] }, { fps: 0, ranges: [[0, 1]] }, { fps: 30, ranges: [[0, 0]] },
    { fps: 30, ranges: [[-1, 1]] }, { fps: 30, ranges: [[0, 1.5]] }, { fps: 30, ranges: [[0, 10], [5, 20]] },
    { fps: 30, ranges: [[30, 40], [0, 10]] }, { fps: 30, ranges: [[0, 10]], ignored: true }]) {
    await check('invalid-display-' + JSON.stringify(display), () => {
      const d = structuredClone(base); Object.assign(opening(d).picture, { display });
      assert.equal(deliverySectionsShape(plan(d).delivery_sections), false);
      assert.throws(() => deliverySectionsFromDoc(d));
    });
  }
  await check('out-of-range-and-fps-mismatch-never-pass', () => {
    for (const d of [setDisplay(structuredClone(base), [[0, 276]]), setDisplay(structuredClone(base), [[0, 157]], 25)]) {
      assert.throws(() => deliverySectionsFromDoc(d)); assert(ready(d).length > 0);
    }
  });
  await check('no-product-id-or-fixed-157-exemption', () => {
    for (const [fps, end] of [[25, 53], [60, 113]]) {
      const before = structuredClone(base); timeline(before).fps = fps;
      const s = opening(before), oldId = s.picture.asset_id, newId = `other-product-${fps}`;
      before.assets.find(a => a.id === oldId)!.id = newId; s.picture.asset_id = newId;
      before.clipMentorAnalysis!.evidence.forEach(e => { e.source_ids = e.source_ids.map(id => id === oldId ? newId : id); });
      timeline(before).items.filter(i => i.sourceAssetId === oldId).forEach(i => { i.sourceAssetId = newId; });
      // The same measured seconds have a matching frame count at each rate.
      const audio = before.assets.find(a => a.kind === 'audio' && a.id === 'df52e6df-1554-4153-a6c8-a25e8e93f45e')!;
      const g = audio.props!.generation as Record<string, unknown>;
      audio.durationInFrames = Math.round(Number(g.durationSeconds) * fps);
      timeline(before).items.filter(i => i.kind === 'audio' && i.sourceAssetId === audio.id).forEach(i => { i.durationInFrames = audio.durationInFrames!; });
      picture(before).durationInFrames = audio.durationInFrames;
      setDisplay(before, [[0, end]], fps);
      withTestBinding(before);
      const after = structuredClone(before); picture(after).durationInFrames = end;
      assertDeliveryPicturePreservation(before, after); assert.deepEqual(ready(after), []);
    }
  });
  await check('review-input-readback-and-content-digest-bind-display', async () => {
    const d = phased(), bytes = JSON.stringify(d), old = await copyReviewSubject(base), subject = await copyReviewSubject(d);
    assert.notEqual(subject.digest, old.digest);
    const packet = await copyTeachingPacketFromDoc(d);
    const request = buildCopyTeachingReviewRequest([{ case_id: 'blind', packet }]);
    assert.deepEqual(request.input.cases[0].packet.delivery_sections![0].picture, opening(d).picture);
    assert.match(request.instructions, /display/);
    const binding = deliveryPictureBindings(d)[0]; assert.equal(binding.status, 'ready');
    assert('display' in binding); assert.deepEqual(binding.display, { fps: 30, ranges: [[0, 157]] });
    assert.equal(JSON.stringify(d), bytes, 'readback never saves or approves a candidate');
    assert.equal((await checkCopyProduction(d, 'clipmentor')).allowed, false, 'historical receipt cannot approve a newly added phase');
  });
  await check('fresh-phase-review-saves-and-rereads-through-original-service', async () => {
    const d = phased(), receiptBefore = JSON.stringify(base.clipMentorAnalysis!.production_copy_review);
    const subject = await copyReviewSubject(d), packet = await copyTeachingPacketFromDoc(d);
    // Synthetic declared verdicts test the protocol, never the semantic quality
    // of the saved product. Do not re-label a historical raw review as a new pass.
    const raw = {
      cases: [{ case_id: 'current', units: packet.units.map(u => ({ unit_id: u.unit_id,
        points: u.points.map(p => { const line = u.lines.find(l => l.point_ids.includes(p.point_id))!;
          return { point_id: p.point_id, learner_takeaway: 'Synthetic protocol positive', connection: 'purchase_connected', basis: 'in_copy', source_support: 'supported', meaning_alignment: 'aligned', reason: 'Synthetic contract test', quotes: [{ line_id: line.line_id, channel: 'narration', text: line.narration_ms }] }; }) })) }],
      copy_units: packet.units.map(u => ({ unit_id: u.unit_id, verdict: 'pass', findings: [],
        narration_checks: u.lines.map(l => ({ line_id: l.line_id, necessity: 'necessary', omission_loss: 'Synthetic protocol loss', naturalness: 'natural', reason: 'Synthetic protocol check' })),
        group_checks: { scope: 'planned_group_teaching_only', source_relations: [{ relation: 'Synthetic complete teaching relation', evidence_ids: [u.source_context!.evidence_ids[0]], point_ids: u.points.map(p => p.point_id), line_ids: u.lines.map(l => l.line_id), assessment: 'covered', reason: 'Synthetic protocol test only' }],
          L1: { verdict: 'pass', learner_takeaway: 'Synthetic relation', reason: 'Synthetic contract test' },
          L2: { verdict: 'pass', viewer_chain: 'Synthetic original then explanation', stage_cues: 'Synthetic cues', reason: 'Synthetic contract test' } } })),
      delivery_checks: packet.delivery_sections!.map(s => ({ section_id: s.section_id, verdict: 'pass', claims_supported: 'supported', purpose_clear: true,
        evidence_ids: [...s.evidence_ids], reason: 'Synthetic protocol positive', narration_checks: [{ line_id: s.line.line_id, necessity: 'necessary', omission_loss: 'Synthetic delivery loss', naturalness: 'natural', reason: 'Synthetic protocol positive' }] })),
    };
    const directory = await mkdtemp(join(tmpdir(), 'delivery-display-'));
    let mockCalls = 0;
    const deps: CopyReviewDependencies = {
      directory, resolve: name => name,
      hash: async file => {
        for (const section of packet.delivery_sections ?? []) {
          if (basename(section.picture.src) === file) return section.picture.sha256;
          if (section.voice.existing_audio && basename(section.voice.existing_audio.src) === file) return section.voice.existing_audio.sha256;
        }
        return d.clipMentorAnalysis!.source.sourceContentHash!;
      },
      frame: async () => Buffer.from('synthetic image for contract verification').toString('base64'),
      run: async prompt => { mockCalls++; assert(prompt.includes('display')); return structuredClone(raw); },
    };
    const input = { operationId: randomUUID(), maxRequests: 1 as const, projectId: 'phase-regression-only', authorRunId: 'test-author',
      source: { src: d.assets.find(a => a.id === d.clipMentorAnalysis!.source.asset_id)!.src!, hash: d.clipMentorAnalysis!.source.sourceContentHash!, fps: timeline(d).fps, duration: d.clipMentorAnalysis!.source.duration_seconds },
      subject: { revision: subject.revision, digest: subject.digest, units: subject.units.map(u => ({ unit_id: u.unit_id, candidate_id: u.candidate_id })) }, packet };
    try {
      const review = await reviewClipMentorCopy(input, deps);
      assert.equal(review.receipt.verdict, 'pass');
      d.clipMentorAnalysis!.production_copy_review = review.receipt;
      assert.equal((await checkCopyProduction(d, 'clipmentor')).allowed, true);
      const before = structuredClone(d); picture(d).durationInFrames = 157;
      assertDeliveryPicturePreservation(before, d); assert.deepEqual(ready(d), []);
      const cached = await reviewClipMentorCopy(input, deps);
      assert.equal(cached.cached, true); assert.equal(mockCalls, 1);
      const ledger = JSON.parse(await readFile(join(directory, input.operationId + '.json'), 'utf8'));
      assert.deepEqual(ledger.raw_review, raw);
      Object.assign(opening(d).picture, { display: { fps: 30, ranges: [[0, 100]] } });
      assert.equal((await checkCopyProduction(d, 'clipmentor')).allowed, false);
      assert.equal(JSON.stringify(base.clipMentorAnalysis!.production_copy_review), receiptBefore);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
} finally { globalThis.fetch = nativeFetch; }
assert.deepEqual(failures, [], `display contract regressions: ${failures.join(', ')}`);
console.log(`${checks.length} delivery display checks; zero real network/model/render calls.`);
