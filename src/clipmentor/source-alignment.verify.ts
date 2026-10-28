import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildSourceContext, sourceReviewRanges, assessSourceAlignment, type SourceRelation } from './source-alignment';
import { buildCopyTeachingReviewRequest, assessGroupReview } from './production-gate';
import type { TeachingPacket } from './production-gate';
import type { ClipMentorAnalysis } from './analysis';
import inputs from './fixtures/source-alignment-inputs-20261026.json';

// These are frozen real source/copy inputs. Declared reviewer outcomes below are synthetic:
// they test evidence delivery and routing, never whether a real model spots the gap.
for (const entry of inputs.cases) {
  const packet = entry.packet as unknown as TeachingPacket;
  const sent = buildCopyTeachingReviewRequest([{case_id: entry.case_id, packet}]);
  for (let i = 0; i < packet.units.length; i++) {
    assert.deepEqual(sent.input.cases[0].packet.units[i].source_context, packet.units[i].source_context,
      'actual request retains original evidence beyond selected points');
  }
}
const bt = inputs.cases[0].packet as unknown as TeachingPacket, ts = inputs.cases[1].packet as unknown as TeachingPacket;
const injected = structuredClone(inputs.cases[0].packet) as unknown as TeachingPacket;
Object.assign(injected.units[0].source_context!, {author_self_review:{expected_answer:'AUTHOR_EXPECTED_PASS_SENTINEL'}});
const isolated = buildCopyTeachingReviewRequest([{case_id:'untrusted-extra',packet:injected}]);
assert(!JSON.stringify(isolated.input).includes('AUTHOR_EXPECTED_PASS_SENTINEL'), 'source context uses a closed projection, never spreads author metadata');

const b = bt.units[0], t = ts.units[0];
const closing = bt.source_evidence.find(e => e.evidence_id === 'BT-E012')!;
assert(closing.observation.includes('换新提醒'));
assert(b.source_context!.evidence_ids.includes(closing.evidence_id));
assert(bt.source_evidence.some(e => e.observation.includes('lama tak') && b.source_context!.evidence_ids.includes(e.evidence_id)),
  'the source speech reaches review even though the selected purchase question only asks quantity');
const goodGroup = { scope: 'planned_group_teaching_only',
  L1: {verdict:'pass',learner_takeaway:'Synthetic basic lesson',reason:'Synthetic protocol check'},
  L2: {verdict:'pass',viewer_chain:'Synthetic original then explanation',stage_cues:'Synthetic stage cue',reason:'Synthetic protocol check'} };
const lost: SourceRelation = {relation:'原片换新人群与消费者购买提醒没有进入当前解释', evidence_ids:[closing.evidence_id],
  point_ids:[],line_ids:[],assessment:'material_gap',reason:'Test-side diagnosis from the frozen comparison, not a model verdict'};
assert.equal(assessGroupReview({...goodGroup,source_relations:[lost]},b).verdict,'needs_revision',
  'newly found gap has no selected ID yet; other passing layers cannot release it');
assert.equal(assessGroupReview(goodGroup,b).verdict,'insufficient_evidence','old passing group lacks the new source accounting');
assert.equal(assessGroupReview({...goodGroup,source_relations:[{...lost,assessment:'uncertain'}]},b).verdict,'insufficient_evidence');
const compare = t.points.find(p => p.point_id === 'R61-03-C')!;
const line = t.lines.find(l => l.point_ids.includes(compare.point_id))!;
assert(line.narration_ms.includes('serentak dalam gambar yang sama'));
const compareEvidence = compare.evidence_ids.find(id => t.source_context!.evidence_ids.includes(id))!;
assert(compareEvidence);
const basic: SourceRelation = {relation:'近镜、两个手背真实同框，让肤色可以一起比较', evidence_ids:[compareEvidence],
  point_ids:[compare.point_id],line_ids:[line.line_id],assessment:'covered',reason:'Real accepted wording; synthetic routing control, not renewed approval'};
const deeper: SourceRelation = {...basic,assessment:'optional_depth',relation:'可补分开展示与同框的对照说明',
  reason:'Optional elaboration does not invalidate the basic stated teaching relation'};
assert.equal(assessGroupReview({...goodGroup,source_relations:[basic,deeper]},t).verdict,'pass',
  'basic qualified comparison is not blocked for lacking an expanded psychological or counterexample explanation');
const closeup = b.points.find(p => p.point_id === 'BT-P03')!;
const closeupLine = b.lines.find(l => l.point_ids.includes(closeup.point_id))!;
const detail: SourceRelation = {relation:'近镜让做工细节可见', evidence_ids:[closeup.evidence_ids.find(id => b.source_context!.evidence_ids.includes(id))!],
  point_ids:[closeup.point_id],line_ids:[closeupLine.line_id],assessment:'covered',reason:'Actual basic supporting sentence; synthetic protocol control'};
assert.equal(assessGroupReview({...goodGroup,source_relations:[detail]},b).verdict,'pass','an ordinary useful supporting explanation can remain concise');
for (const change of [
  (v:any)=>{v.assessment=['covered'];}, (v:any)=>{v.evidence_ids=['missing'];},
  (v:any)=>{v.point_ids=['invented'];}, (v:any)=>{v.line_ids=['invented'];},
  (v:any)=>{v.point_ids=[];}, (v:any)=>{v.line_ids=[];}, (v:any)=>{v.reason=' ';},
]) {
  const malformed=structuredClone(basic);change(malformed);
  assert.equal(assessSourceAlignment(t.source_context!,t.points,t.lines,[malformed]).verdict,'insufficient_evidence');
}
const pointOnly=structuredClone(bt);
pointOnly.units[0].source_context!.evidence_ids.push('not-in-evidence-pool');
assert.throws(()=>buildCopyTeachingReviewRequest([{case_id:'bad-ref',packet:pointOnly}]));
const visual=t.points.find(p=>p.treatment==='visual_only')!;
assert(visual);
const visible:SourceRelation={relation:'人物由原片画面承担',evidence_ids:[visual.evidence_ids.find(id=>t.source_context!.evidence_ids.includes(id))!],
  point_ids:[visual.point_id],line_ids:[],assessment:'covered',reason:'Synthetic routing for real visual-only plan, not a new semantic approval'};
assert.equal(assessGroupReview({...goodGroup,source_relations:[visible]},t).verdict,'pass');

// All scoped raw evidence, not just the point-referenced subset; no author WHY/history.
const source={source:{sourceContentHash:'a'.repeat(64),duration_seconds:100},evidence:[
 {evidence_id:'selected',kind:'visible_action',status:'observed',text:'visible demonstration',time_seconds:2},
 {evidence_id:'unselected',kind:'original_claim',status:'candidate',text:'unselected purchase invitation',source_range_seconds:[8,9]},
 {evidence_id:'outside',kind:'original_claim',status:'candidate',text:'out of current local scope',source_range_seconds:[90,99]},
 {evidence_id:'author',kind:'expression_analysis_not_verified_causal_effect',status:'candidate',text:'AUTHOR_VERDICT_NOT_ORIGINAL',source_range_seconds:[1,9]},
],transcripts:[{source_id:'original',provider:'saved-asr',status:'candidate',words:Array.from({length:80},(_,i)=>({start_seconds:i,end_seconds:i+0.5,text:`w${i}`}))}]} as unknown as ClipMentorAnalysis;
const before=JSON.stringify(source), pool:TeachingPacket['source_evidence']=[];
const begin=performance.now();const context=buildSourceContext(source,[[0,10],[20,70]],pool);
assert(context.evidence_ids.includes('unselected') && !context.evidence_ids.includes('outside') && !context.evidence_ids.includes('author'));
assert(pool.every(e=>!e.observation.includes('AUTHOR_VERDICT')));
const spoken=pool.filter(e=>e.evidence_id.startsWith('raw-speech:'));
for(const e of spoken)assert(context.source_ranges.some(r=>e.time_seconds![0]>=r[0]&&e.time_seconds![1]<=r[1]),'no text passage joins disjoint ranges');
for(const i of [...Array.from({length:10},(_,i)=>i),...Array.from({length:50},(_,i)=>i+20)])assert(spoken.some(e=>e.observation.split(' ').includes(`w${i}`)));
assert.equal(JSON.stringify(source),before,'building a packet cannot mutate source analysis');
const size=pool.length;buildSourceContext(source,[[0,10],[20,70]],pool);assert.equal(pool.length,size,'shared passages are not duplicated on repeat use');
const mismatched=structuredClone(source);mismatched.source_transcription={source_hash:'b'.repeat(64)} as never;
assert.equal(buildSourceContext(mismatched,[[0,10]],[]).speech,'unavailable','changed-source transcript is not silently reused');
assert.throws(()=>buildSourceContext(source,[[0,101]],[]));
assert.throws(()=>buildSourceContext(source,[],[]));
const pointWords=structuredClone(source);
pointWords.transcripts[0].words=[{text:'不要',start_seconds:1,end_seconds:1},{text:'购买',start_seconds:1.2,end_seconds:1.5},{text:'边界外',start_seconds:10,end_seconds:10}];
const pointPool:TeachingPacket['source_evidence']=[];buildSourceContext(pointWords,[[0,10]],pointPool);
const pointSpeech=pointPool.filter(e=>e.evidence_id.startsWith('raw-speech:')).map(e=>e.observation).join(' ');
assert(pointSpeech.includes('不要 购买') && !pointSpeech.includes('边界外'), 'valid zero-duration qualifiers survive; the half-open scope excludes its end point');
pointWords.transcripts[0].words=[{text:'不',start_seconds:1,end_seconds:1}];
const onePointPool:TeachingPacket['source_evidence']=[];buildSourceContext(pointWords,[[0,10]],onePointPool);
assert(onePointPool.some(e=>e.evidence_id.startsWith('raw-speech:')&&e.observation.endsWith('不')));
pointWords.transcripts[0].words=[{text:'不要',start_seconds:0.9,end_seconds:1.1},{text:'购买',start_seconds:1.2,end_seconds:1.5}];
const boundaryPool:TeachingPacket['source_evidence']=[];buildSourceContext(pointWords,[[1,3]],boundaryPool);
assert(boundaryPool.some(e=>e.observation.includes('boundary context')&&e.observation.includes('不要 购买')), 'cross-boundary qualifier is retained with an explicit unverified-boundary notice');
const broad=structuredClone(source);broad.evidence.push({evidence_id:'broad',kind:'original_claim',status:'candidate',text:'OUTSIDE_OPENING_AND_CTA',source_range_seconds:[0,100]} as never);
const broadPool:TeachingPacket['source_evidence']=[];buildSourceContext(broad,[[20,30]],broadPool);
assert(!broadPool.some(e=>e.evidence_id==='broad'),'a broad statement cannot stand as local in-range proof');
const full=structuredClone(source);full.source_breakdown={version:1,segments:[],points:[],units:[],review_scope:{kind:'full_source',instruction:'Frozen complete task'}};
assert.deepEqual(sourceReviewRanges(full),[[0,100]],'complete review scope does not shrink with selected playback');
const fullPool:TeachingPacket['source_evidence']=[];assert(buildSourceContext(full,sourceReviewRanges(full),fullPool).evidence_ids.includes('outside'), 'complete task preserves unselected late purchase evidence');
full.source_breakdown!.review_scope={kind:'local_ranges',source_ranges:[[0,10]],instruction:'Frozen explicit local task'};
assert.deepEqual(sourceReviewRanges(full),[[0,10]]);
assert(!buildSourceContext(full,sourceReviewRanges(full),[]).evidence_ids.includes('outside'), 'explicit local scope excludes outside opening/closing');
assert.equal(assessSourceAlignment(buildSourceContext(source,[[0,10]],[]),[],[],[]).verdict,'insufficient_evidence','legacy unconfirmed scope cannot inherit approval');
pointWords.transcripts[0].words=[{text:'长词',start_seconds:1,end_seconds:2},{text:'重叠词',start_seconds:1.1,end_seconds:1.5}];
const overlapPool:TeachingPacket['source_evidence']=[];buildSourceContext(pointWords,[[0,10]],overlapPool);
assert.deepEqual(overlapPool.find(e=>e.evidence_id.startsWith('raw-speech:'))!.time_seconds,[1,2],'passage range covers every retained word, including overlapping timestamps');
const noSpeech=structuredClone(source);noSpeech.transcripts=[];
assert.equal(buildSourceContext(noSpeech,[[0,10]],[]).speech,'unavailable');
// An unresolved source detail is not itself an unresolved assertion in the current copy.
const scopedLine = {...closeupLine};
const scopedCovered = {...detail};
const scopedUnknown:any = {...detail, assessment:'uncertain', relation:'An untranscribed background detail',
  reason:'The detail remains unknown; the current near-view statement only describes visible finishing.',
  claim_impact:{status:'does_not_affect_current_claim',unknown_detail:'The background detail is not transcribed',
    reason:'The current copy only explains what the near view lets viewers inspect; that relationship is independently covered.',
    claims:[{line_id:scopedLine.line_id,channel:'narration',quote:scopedLine.narration_ms}]}};
assert.equal(assessSourceAlignment(b.source_context!,b.points,[scopedLine],[scopedCovered,scopedUnknown]).verdict,'pass',
  'a justified non-impacting unknown must remain recorded without blocking supported copy');
for (const mutate of [
 (x:any)=>{delete x.claim_impact;},
 (x:any)=>{x.claim_impact.status='affects_current_claim';},
 (x:any)=>{x.claim_impact.status='unresolved';},
 (x:any)=>{x.claim_impact.reason=' ';},
 (x:any)=>{x.claim_impact.claims[0].quote='not the current copy';},
 (x:any)=>{x.claim_impact.claims[0].line_id='invented';},
 (x:any)=>{x.claim_impact.claims[0].channel='invented';},
 (x:any)=>{x.claim_impact.claims=[];},
 (x:any)=>{x.evidence_ids=[];},
 (x:any)=>{x.point_ids=[];},
 (x:any)=>{x.line_ids=[];},
]) {
 const unsafe=structuredClone(scopedUnknown);mutate(unsafe);
 assert.equal(assessSourceAlignment(b.source_context!,b.points,[scopedLine],[scopedCovered,unsafe]).verdict,'insufficient_evidence');
}
assert.equal(assessSourceAlignment(b.source_context!,b.points,[scopedLine],[scopedUnknown]).verdict,'insufficient_evidence',
 'the non-impact declaration cannot replace a supported current relationship');
assert.equal(assessSourceAlignment(b.source_context!,b.points,[scopedLine],[scopedCovered,scopedUnknown,{...lost}]).verdict,'needs_revision',
 'a non-impacting unknown never cancels a material teaching gap');
const impactSnapshot=JSON.stringify(scopedUnknown);
assessSourceAlignment(b.source_context!,b.points,[scopedLine],[scopedCovered,scopedUnknown]);
assert.equal(JSON.stringify(scopedUnknown),impactSnapshot,'aggregation cannot rewrite the original assessment');
console.log('source-alignment: frozen Barely There/Teashell inputs, source-first projection, unselected evidence/speech, material gap vs optional depth, basic/auxiliary/visual controls, invalid references and scoped compact passages passed; no model calls.');
console.log(JSON.stringify({compact_passages:spoken.length,pool_entries:pool.length,elapsed_ms:Math.round((performance.now()-begin)*100)/100}));
