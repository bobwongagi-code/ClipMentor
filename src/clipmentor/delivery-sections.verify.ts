import assert from 'node:assert/strict';
import {readFileSync}from'node:fs';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
import type{ProjectDoc,TimelineItem}from'../editor/types';
import{deliveryReview,deliveryAudio,type DeliverySection}from'./delivery-sections';
import{checkSourceBreakdown}from'./source-breakdown';import{checkCopyProduction,copyReviewSubject,isReviewedNarrationText,copyTeachingPacketFromDoc}from'./production-gate';
import{prepareProductionBlueprint,productionBlueprintReadiness}from'../../server/clipmentor/production-readiness';
import{reviewClipMentorCopy,type CopyReviewDependencies}from'../../server/clipmentor/copy-review';
const doc=JSON.parse(readFileSync(new URL('./fixtures/grouped-registration-v1.json',import.meta.url),'utf8'))as ProjectDoc;
const a=doc.clipMentorAnalysis!,internal=(a.blueprint[0]as any).internal_review,plan=internal[internal.current_picture_plan];
const sections:DeliverySection[]=['performance_opening','creator_invitation'].map((kind,i)=>({section_id:'section-'+i,kind:kind as DeliverySection['kind'],
 line:{line_id:'delivery-line-'+i,narration_ms:i?'Mesej kami.':'Video ini mendapat tontonan.',caption_lines:[i?'Mesej kami.':'Video ini mendapat tontonan.'],meaning_zh:'Synthetic delivery copy',labels:[]},
 evidence_ids:['delivery-evidence-'+i],picture:{asset_id:'still-'+i,src:'/media/uploads/still-'+i+'.jpg',sha256:String(i+1).repeat(64),description:'Synthetic provided material'},voice:{provider:'minimax',voiceId:'test-voice',speed:1}}));
plan.delivery_sections=sections;
for(const s of sections){
 doc.assets.push({id:s.picture.asset_id,kind:'image',src:s.picture.src,name:'Synthetic still',sourceContentHash:s.picture.sha256,durationInFrames:150});
 a.evidence.push({evidence_id:s.evidence_ids[0],kind:'operator_supplied',text:'Synthetic user-supplied performance or audience fact',status:'supplied',source_ids:[s.picture.asset_id],supporting_evidence_ids:[]});
}
const {makeDraft}=await import('../editor/store');const {execClipMentorAnalysisTool}=await import('../agent/tools/clipmentor-analysis-tools');
const base=structuredClone(doc);base.clipMentorAnalysis!.evidence=base.clipMentorAnalysis!.evidence.filter(e=>!e.evidence_id.startsWith('delivery-evidence-'));delete (base.clipMentorAnalysis!.blueprint[0] as any).internal_review[internal.current_picture_plan].delivery_sections;
for(const missing of [false,true]){const draft=makeDraft(base),e={...a.evidence.find(e=>e.evidence_id==='delivery-evidence-0')!,status:'operator_provided_not_independently_verified',source_ids:[missing?'missing-image':'still-0']};const result:any=await execClipMentorAnalysisTool('revise_clipmentor_analysis',{action:'append',records:{evidence:[e]},expectedRevision:base.clipMentorAnalysis!.revision,actor:{operator:'test',executor:'test',instruction:'Synthetic user evidence binding',identity:'local_declared_not_authenticated'},reason:'Contract regression'}, {...draft,getCreativeMode:()=> 'clipmentor',templates:[],audio:[]});assert.equal(!!result.ok,!missing);}
const prepared=await prepareProductionBlueprint(doc);assert.equal(prepared.packet.delivery_sections!.length,2);assert.equal(prepared.packet.units[0].lines.length,5,'delivery never invents extra teaching lines or drops the body');
const subject=await copyReviewSubject(doc);assert(isReviewedNarrationText(subject,sections[0].line.narration_ms));assert(!isReviewedNarrationText(subject,'Unregistered extra copy'));
assert.equal(checkSourceBreakdown(doc).status,'structurally_ready');assert(!(await checkCopyProduction(doc,'clipmentor')).allowed,'having sections is not approval');
for(const mutate of [
 (d:ProjectDoc)=>{d.assets.find(a=>a.id==='still-0')!.sourceContentHash='f'.repeat(64);},
 (d:ProjectDoc)=>{d.assets=d.assets.filter(a=>a.id!=='still-0');},
 (d:ProjectDoc)=>{d.clipMentorAnalysis!.evidence=d.clipMentorAnalysis!.evidence.filter(e=>e.evidence_id!=='delivery-evidence-0');},
 (d:ProjectDoc)=>{const i=(d.clipMentorAnalysis!.blueprint[0]as any).internal_review;i[i.current_picture_plan].delivery_sections[0].line.caption_lines=['Different words'];},
 (d:ProjectDoc)=>{const i=(d.clipMentorAnalysis!.blueprint[0]as any).internal_review;i[i.current_picture_plan].delivery_sections[0].picture.src='/etc/passwd';},
 (d:ProjectDoc)=>{const i=(d.clipMentorAnalysis!.blueprint[0]as any).internal_review;i[i.current_picture_plan].delivery_sections[0].picture.crop={left:0.7,right:0.7,top:0,bottom:0};},
]){const bad=structuredClone(doc);mutate(bad);await assert.rejects(prepareProductionBlueprint(bad));}
const checks=sections.map(s=>({section_id:s.section_id,verdict:'pass',claims_supported:'supported',purpose_clear:true,evidence_ids:s.evidence_ids,reason:'Synthetic contract positive',narration_checks:[{line_id:s.line.line_id,necessity:'necessary',omission_loss:'Synthetic missing performance context or action',naturalness:'natural',reason:'Synthetic contract positive'}]}));
assert.equal(deliveryReview(prepared.packet.delivery_sections!,checks).verdict,'pass');
for(const raw of [undefined,[],checks.slice(1),[checks[0],checks[0]],checks.map(c=>({...c,evidence_ids:['missing']})),checks.map(c=>({...c,narration_checks:[]})),checks.map(c=>({...c,claims_supported:'uncertain'})),checks.map(c=>({...c,verdict:'needs_revision'}))])assert.notEqual(deliveryReview(prepared.packet.delivery_sections!,raw).verdict,'pass');
const t=doc.timelines.find(t=>t.id===doc.activeTimelineId)!;const fps=t.fps;
for(const[i,s]of sections.entries())doc.assets.push({id:'voice-'+i,kind:'audio',name:'Synthetic measured voice',src:'/media/uploads/voice-'+i+'.mp3',durationInFrames:i?60:90,props:{generation:{provider:s.voice.provider,voiceId:s.voice.voiceId,speed:1,text:s.line.narration_ms,durationSeconds:i?2:3}}});
assert.equal(deliveryAudio(doc,sections[0]).frames,90);
const badVoice=structuredClone(doc);(badVoice.assets.find(a=>a.id==='voice-0')!.props!.generation as any).speed=1.2;assert.throws(()=>deliveryAudio(badVoice,sections[0]));
const noVoice=structuredClone(doc);noVoice.assets=noVoice.assets.filter(a=>a.id!=='voice-0');assert.throws(()=>deliveryAudio(noVoice,sections[0]));
let cursor=0;const rows=plan.phases.map((p:any,i:number)=>{const r=p.source_range_seconds.map((s:number)=>Math.round(s*fps)),start=cursor;cursor+=r[1]-r[0];return{row_id:'row-'+i,unit_id:'BT-U01',kind:p.mode,source_asset_id:a.source.asset_id,source_frames:r,output_frames_reference:[start,cursor],line_ids:p.line_id?[p.line_id]:[]};});
plan.composition.detail=JSON.stringify({production_rows:rows});
t.items=rows.map((r:any,i:number)=>({id:'video-'+i,kind:'video',track:'V1',sourceAssetId:a.source.asset_id,src:doc.assets[0].src,startFrame:90+r.output_frames_reference[0],durationInFrames:r.output_frames_reference[1]-r.output_frames_reference[0],srcInFrame:r.source_frames[0],volume:r.kind==='original'?1:0} as TimelineItem));
for(const[i,s]of sections.entries()){
 const start=i?90+cursor:0,length=i?60:90;
 t.items.push({id:'picture-'+i,kind:'image',sourceAssetId:s.picture.asset_id,src:s.picture.src,track:'V1',startFrame:start,durationInFrames:length}as TimelineItem);
 t.items.push({id:'audio-'+i,kind:'audio',sourceAssetId:'voice-'+i,src:'/media/uploads/voice-'+i+'.mp3',track:'A1',startFrame:start,durationInFrames:length}as TimelineItem);
}
assert.equal(checkSourceBreakdown(doc,true).status,'structurally_ready','delivery offsets must preserve the source checker and four-group order');
for(const mutate of [
 (d:ProjectDoc)=>{d.timelines[0].items=d.timelines[0].items.filter(i=>i.id!=='picture-0');},
 (d:ProjectDoc)=>{d.timelines[0].items.find(i=>i.id==='audio-0')!.durationInFrames--;},
 (d:ProjectDoc)=>{d.timelines[0].items.find(i=>i.id==='audio-1')!.startFrame++;},
 (d:ProjectDoc)=>{d.timelines[0].items.find(i=>i.id==='video-1')!.srcInFrame!+=30;},
 (d:ProjectDoc)=>{d.timelines[0].items.find(i=>i.id==='audio-0')!.src='/media/uploads/wrong.mp3';},
 (d:ProjectDoc)=>{d.timelines[0].items.find(i=>i.id==='picture-0')!.src='/media/uploads/wrong.jpg';},
]){const bad=structuredClone(doc);mutate(bad);assert.notEqual(checkSourceBreakdown(bad,true).status,'structurally_ready');}
// Exercise the original real service with fake frame/provider dependencies and
// temp storage. No local Codex process, network, production data or TTS involved.
const packet=await copyTeachingPacketFromDoc(doc),sub=await copyReviewSubject(doc);let fakeCalls=0;let sentPrompt='';const dir=await mkdtemp(join(tmpdir(),'delivery-review-'));
const raw={cases:[{case_id:'current',units:packet.units.map(u=>({unit_id:u.unit_id,points:u.points.map(p=>({point_id:p.point_id,learner_takeaway:'Synthetic protocol positive',connection:'purchase_connected',basis:'in_copy',source_support:'supported',meaning_alignment:'aligned',reason:'Synthetic contract test',quotes:[{line_id:u.lines.find(l=>l.point_ids.includes(p.point_id))!.line_id,channel:'narration',text:u.lines.find(l=>l.point_ids.includes(p.point_id))!.narration_ms}]}))}))}],copy_units:packet.units.map(u=>({unit_id:u.unit_id,verdict:'pass',findings:[],narration_checks:u.lines.map(l=>({line_id:l.line_id,necessity:'necessary',omission_loss:'Synthetic contract loss',naturalness:'natural',reason:'Synthetic contract positive'})),group_checks:{scope:'planned_group_teaching_only',source_relations:[{relation:'Synthetic complete teaching relation',evidence_ids:[u.source_context!.evidence_ids[0]],point_ids:u.points.map(p=>p.point_id),line_ids:u.lines.map(l=>l.line_id),assessment:'covered',reason:'Synthetic test only'}],L1:{verdict:'pass',learner_takeaway:'Synthetic relation',reason:'Synthetic contract positive'},L2:{verdict:'pass',viewer_chain:'Synthetic source then explanation',stage_cues:'Synthetic cues',reason:'Synthetic contract positive'}}})),delivery_checks:checks};
const req={operationId:randomUUID(),maxRequests:1 as const,projectId:'delivery-test',authorRunId:'test-author',source:{src:doc.assets[0].src,hash:a.source.sourceContentHash!,fps,duration:a.source.duration_seconds},subject:{revision:sub.revision,digest:sub.digest,units:sub.units.map(u=>({unit_id:u.unit_id,candidate_id:u.candidate_id}))},packet};
const deps:CopyReviewDependencies={directory:dir,resolve:n=>n,hash:async n=>n.startsWith('still-0')?'1'.repeat(64):n.startsWith('still-1')?'2'.repeat(64):a.source.sourceContentHash!,frame:async()=>Buffer.from('synthetic image').toString('base64'),run:async(_p,frames)=>{sentPrompt=_p;assert(_p.includes('对比或“很多人在卖”等前提必须有给定证据支持'),'comparison premises must reach the actual provider prompt');assert(_p.includes('不得暗示其他视频表现差或拆解能证明成交原因'),'inferiority and causal-claim checks must reach the actual provider prompt');assert(!_p.includes('SYNTHETIC_COMPARISON_AUTHOR_ANSWER'),'author answers must stay isolated');fakeCalls++;assert.equal(frames.filter(f=>f.phase==='delivery').length,2);return structuredClone(raw);}};
try{const result=await reviewClipMentorCopy(req,deps);assert.equal(result.receipt.verdict,'pass');doc.clipMentorAnalysis!.production_copy_review=result.receipt;assert.equal((await checkCopyProduction(doc,'clipmentor')).allowed,true);
 const frozen=JSON.parse(readFileSync(new URL('./fixtures/comparison-hook-baseline.json',import.meta.url),'utf8'));
 const oldApproval=structuredClone(doc);oldApproval.clipMentorAnalysis!.production_copy_review=frozen.receipt;
 assert.equal((await checkCopyProduction(oldApproval,'clipmentor')).code,'copy_review_stale','frozen formerly accepted opening approval cannot authorize the new standards');
 assert.notEqual(sub.digest,frozen.delivery_subject_digest);
 const bodyOnly=structuredClone(doc);delete(bodyOnly.clipMentorAnalysis!.blueprint[0] as any).internal_review[internal.current_picture_plan].delivery_sections;
 assert.equal((await copyReviewSubject(bodyOnly)).digest,frozen.body_subject_digest,'body-only digest remains unchanged');
 const cleanPrompt=sentPrompt, annotated=structuredClone(req);annotated.operationId=randomUUID();
 const marked=annotated.packet as any;marked.author_notes='SYNTHETIC_COMPARISON_AUTHOR_ANSWER';
 marked.units[0].case_expected_answer='SYNTHETIC_COMPARISON_AUTHOR_ANSWER';
 marked.delivery_sections[0].line.case_expected_answer='SYNTHETIC_COMPARISON_AUTHOR_ANSWER';
 marked.delivery_sections[0].picture.author_reason='SYNTHETIC_COMPARISON_AUTHOR_ANSWER';
 await reviewClipMentorCopy(annotated,deps);
 assert.equal(sentPrompt,cleanPrompt,'actual service prompt must preserve material and omit author-only metadata');
 const rejected=structuredClone(raw);rejected.delivery_checks[0].claims_supported='uncertain';
 const negative=await reviewClipMentorCopy({...req,operationId:randomUUID()},{...deps,run:async()=>{fakeCalls++;return rejected;}});
 assert.notEqual(negative.receipt.verdict,'pass','unsupported claims remain blocked');
 const revision=structuredClone(raw);revision.delivery_checks[0].verdict='needs_revision';
 assert.notEqual((await reviewClipMentorCopy({...req,operationId:randomUUID()},{...deps,run:async()=>{fakeCalls++;return revision;}})).receipt.verdict,'pass','revision-required claims remain blocked');
 assert.notEqual(deliveryReview(packet.delivery_sections!,checks.slice(1)).verdict,'pass','missing opening check cannot be approved');
 const mixed=structuredClone(raw);mixed.copy_units[0].verdict='needs_revision';mixed.delivery_checks[0].claims_supported='uncertain';
 const mixedResult=await reviewClipMentorCopy({...req,operationId:randomUUID()},{...deps,run:async()=>{fakeCalls++;return mixed;}});assert.equal(mixedResult.receipt.verdict,'needs_revision','explicit body revision cannot be downgraded to uncertain delivery evidence');
 console.log('Comparison hook: actual outgoing criteria + author isolation, frozen old approval stale, body-only digest unchanged, fresh approval and uncertain/revision/missing controls passed; fake reviewer calls 5, real calls 0.');

 const withoutOpening=structuredClone(doc);withoutOpening.assets=withoutOpening.assets.filter(a=>a.id!=='voice-0');const readiness=await productionBlueprintReadiness(withoutOpening);assert.equal(readiness.next,'audio');assert('missing_line_ids' in readiness&&readiness.missing_line_ids?.includes(sections[0].line.line_id),'readiness must report missing delivery audio');
 assert.equal((await reviewClipMentorCopy(req,deps)).cached,true);assert.equal(fakeCalls,5,'receipt reread does not call provider again');
 const bad=structuredClone(doc);delete bad.clipMentorAnalysis!.production_copy_review!.delivery_checks;assert(!(await checkCopyProduction(bad,'clipmentor')).allowed);
 const changed=structuredClone(doc);changed.assets.find(a=>a.id==='still-0')!.sourceContentHash='f'.repeat(64);assert(!(await checkCopyProduction(changed,'clipmentor')).allowed);
}catch(e){console.error('delivery service regression',e);throw e;}finally{await rm(dir,{recursive:true,force:true});}
// Existing voice submission must persist its actual text/config and measured
// duration, so a new approved opening can be bound without restamping a review.
const nativeFetch=globalThis.fetch;let voiceRequests=0;
globalThis.fetch=(async()=>{voiceRequests++;return new Response(JSON.stringify({path:'/media/uploads/synthetic-voice.mp3',durationSeconds:3}),{status:200,headers:{'Content-Type':'application/json'}});})as typeof fetch;
try{const{submitVoice}=await import('../generate/voice');const generated=await submitVoice({provider:'minimax',voiceId:'test-voice',text:'Approved new opening.',speed:1},t);assert.equal((generated.props?.generation as any).text,'Approved new opening.');assert.equal((generated.props?.generation as any).durationSeconds,3);assert.equal(voiceRequests,1);}finally{globalThis.fetch=nativeFetch;}
console.log('Delivery sections: still/evidence/copy/voice binding, unchanged teaching gate, offsets, missing/stale/negative controls, original fake service save/read passed; zero real provider calls.');
