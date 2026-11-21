import assert from 'node:assert/strict';
import {readFileSync}from'node:fs';import{mkdtemp,readFile,rm,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
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
// Current contract on the same real review service. Fakes only supply frames and raw replies.
{
 const {parseHandoffBrief,openingComparisonCriterion,visualDoneCriteria}=await import('../../shared/clipmentor-handoff');
 const {assessGroupReview}=await import('./production-gate');
 const {copyReviewDependencies}=await import('../../server/clipmentor/copy-review');
 const quote='同样拍这款商品，问为什么这支视频能拿到这个成绩。';
 const opening={kind:'opening_comparison',quote} as const;
 const parse=(doneCriteria:unknown[])=>parseHandoffBrief({version:1,briefId:'strict-review',revision:1,mode:'autonomous',
  phase:'planning',planner:'builtin_agent',executor:'builtin_agent',projectId:req.projectId,timelineId:t.id,
  objective:'Fixture only',doneCriteria,blueprint:null,budget:{maxModelTurns:0,maxToolCalls:0,maxElapsedMs:2000,paidToolCalls:{}}});
 const policy=(doneCriteria:unknown[])=>({version:1 as const,brief:parse(doneCriteria),digest:'a'.repeat(64),
  assetBindings:[],runIds:[],startedAt:null,modelTurns:0,toolCalls:0,paidCalls:{},callIds:[]});
 assert.deepEqual(openingComparisonCriterion(policy([opening]).brief.doneCriteria),opening);
 assert.deepEqual(visualDoneCriteria(policy([opening]).brief.doneCriteria),[]);
 assert.throws(()=>policy([opening,opening]),/duplicate/);
 assert.throws(()=>policy([{...opening,quote:' '}]),/invalid/);
 assert(copyReviewDependencies().requirements,'the actual host always selects the current contract');
 const makeCurrent=async(narration:string)=>{
  const copy=structuredClone(doc);
  const ir=(copy.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  ir[ir.current_picture_plan].delivery_sections[0].line.narration_ms=narration;
  ir[ir.current_picture_plan].delivery_sections[0].line.caption_lines=[narration];
  const subject=await copyReviewSubject(copy),packet=await copyTeachingPacketFromDoc(copy);
  return {copy,input:{...req,operationId:randomUUID(),subject:{...req.subject,digest:subject.digest},packet}};
 };
 const premise='Produk yang sama',question='kenapa video ini dapat lebih lima juta tontonan?';
 const {copy,input}=await makeCurrent(premise+', '+question+' Jom tengok caranya.');
 const response=structuredClone(raw);
 const grouped=response.copy_units[0];
 const currentUnit=input.packet.units[0];
 // This saved fixture has four known playback groups. In the last group there are two lines.
 const groupLineIndexes=[0,1,2,3];
 const groupReply=groupLineIndexes.map((lineIndex,index)=>{
  const line=currentUnit.lines[lineIndex];
  return {...structuredClone(grouped.group_checks),group_id:'G'+(index+1),
   L1:{...grouped.group_checks.L1,evidence:[{kind:'copy',line_id:line.line_id,channel:'narration',quote:line.narration_ms}]}};
 });
 const reply={...response,copy_units:[{...grouped,group_checks:groupReply}],
  delivery_checks:[{...response.delivery_checks[0],opening_comparison:{status:'preserved',same_product_quote:premise,
   outcome_question_quote:question,reason:'Compare the opening on the same product with the named result of this video.'}},response.delivery_checks[1]]};
 const root=await mkdtemp(join(tmpdir(),'content-review-'));
 let requests=0;
 let taskPolicy=policy([opening]);
 const service:CopyReviewDependencies={...deps,directory:root,requirements:async()=>({policy:taskPolicy,opening:openingComparisonCriterion(taskPolicy.brief.doneCriteria)}),run:async(prompt)=>{
  requests++;
  assert(prompt.includes('L1.evidence'));
  assert.equal(prompt.includes(quote),!!openingComparisonCriterion(taskPolicy.brief.doneCriteria));
  return structuredClone(reply);
 }};
 const changed=(test:(value:typeof reply)=>void)=>{
  const altered=structuredClone(reply);test(altered);
  return {...service,run:async()=>{requests++;return altered;}};
 };
 try{
  const positive=await reviewClipMentorCopy(input,service);
  assert.equal(positive.receipt.verdict,'pass');
  copy.clipMentorAnalysis!.production_copy_review=positive.receipt;
  assert.equal((await checkCopyProduction(copy,'clipmentor',undefined,opening)).allowed,true);
  const upgrade={...service,requirements:async()=>({policy:taskPolicy,opening,endingPictures:true})};
  assert.equal((await checkCopyProduction(copy,'clipmentor',undefined,opening,true)).code,'copy_delivery_review_not_passed');
  const spent=requests;
  await assert.rejects(reviewClipMentorCopy(input,upgrade),/operation unavailable|operation_unavailable/);
  const original=await reviewClipMentorCopy(input,upgrade,undefined,true);
  assert.deepEqual(original.receipt,positive.receipt,'read-only recovery preserves the historical ruling');
  assert.equal(requests,spent,'upgrading the ending contract cannot resubmit a consumed review');
  assert.equal((await checkCopyProduction(copy,'clipmentor',undefined,{...opening,quote:'Changed current requirement'})).code,'copy_delivery_review_not_passed');
  const forged=structuredClone(copy);
  const review=forged.clipMentorAnalysis!.production_copy_review!;
  review.units[0].group_checks!.group_reviews![1].L1.evidence=groupReply[0].L1.evidence;
  assert.equal((await checkCopyProduction(forged,'clipmentor')).code,'copy_group_review_not_passed','saved overall pass cannot bless a neighboring playback group');

  const cases=[
   {id:'missing-opening',mutate:(v:typeof reply)=>delete (v.delivery_checks[0] as any).opening_comparison,verdict:'insufficient_evidence'},
   {id:'overlapping-opening-quotes',mutate:(v:typeof reply)=>(v.delivery_checks[0] as any).opening_comparison.outcome_question_quote='yang sama',verdict:'insufficient_evidence'},
   {id:'invented-opening-quote',mutate:(v:typeof reply)=>(v.delivery_checks[0] as any).opening_comparison.same_product_quote='A quote absent from Malay copy',verdict:'insufficient_evidence'},
   {id:'opening-question-swapped',mutate:(v:typeof reply)=>(v.delivery_checks[0] as any).opening_comparison.status='changed',verdict:'needs_revision'},
   {id:'missing-L1',mutate:(v:typeof reply)=>delete (v.copy_units[0].group_checks[1].L1 as any).evidence,verdict:'insufficient_evidence'},
   {id:'neighboring-group-quote',mutate:(v:typeof reply)=>v.copy_units[0].group_checks[1].L1.evidence=v.copy_units[0].group_checks[0].L1.evidence,verdict:'insufficient_evidence'},
   {id:'invented-L1-quote',mutate:(v:typeof reply)=>v.copy_units[0].group_checks[0].L1.evidence[0].quote='A fabricated teaching line',verdict:'insufficient_evidence'},
   {id:'group-aggregate-only',mutate:(v:typeof reply)=>(v.copy_units[0] as any).group_checks=grouped.group_checks,verdict:'insufficient_evidence'},
  ];
  for(const test of cases){
   const result=await reviewClipMentorCopy({...input,operationId:randomUUID()},changed(test.mutate));
   assert.equal(result.receipt.verdict,test.verdict,test.id);
   const rejected=structuredClone(copy);rejected.clipMentorAnalysis!.production_copy_review=result.receipt;
   assert.equal((await checkCopyProduction(rejected,'clipmentor',undefined,opening)).allowed,false,test.id);
  }
  const topicSwap=await makeCurrent('Video ini mendapat lebih lima juta tontonan. Sebelum kenalkan produk, apa yang dia tunjuk dulu?');
  assert.equal((await reviewClipMentorCopy(topicSwap.input,service)).receipt.verdict,'insufficient_evidence','the old question has no matching required quotes');
  taskPolicy=policy(['plain reporting allowed']);
  assert.equal((await reviewClipMentorCopy({...req,operationId:randomUUID()},changed(v=>delete (v.delivery_checks[0] as any).opening_comparison))).receipt.verdict,'pass','a task without a specified comparison can report performance plainly');
  // Simulate a policy change after the service settled, just before the
  // actual review tool tries to attach the old response to the current draft.
  const {configureSharedKvBackend}=await import('../persist/sharedKv');
  const {HANDOFF_PREFIX}=await import('../../shared/clipmentor-handoff');
  const {requestClipMentorCopyReview}=await import('./request-copy-review');
  const draft=makeDraft(copy),before=draft.getDoc();
  configureSharedKvBackend({get:async(key:string)=>{
   assert.equal(key,HANDOFF_PREFIX+input.projectId);return policy([{...opening,quote:'Changed before tool bind'}]);
  }} as unknown as Parameters<typeof configureSharedKvBackend>[0]);
  try{
   const rejected=await requestClipMentorCopyReview({operationId:input.operationId,maxRequests:1,expectedRevision:input.subject.revision},
    {...draft,getCreativeMode:()=> 'clipmentor',getProjectId:()=>input.projectId,getAgentRunId:()=>input.authorRunId,
     templates:[],audio:[],hostFetch:async()=>Response.json(positive)}) as {diagnostic?:{code:string;requestsAttempted:number}};
   assert.equal(rejected.diagnostic?.code,'review_requirements_changed');
   assert.equal(rejected.diagnostic?.requestsAttempted,1);
   assert.equal(draft.getDoc(),before,'a stale receipt never replaces the current saved approval');
  }finally{configureSharedKvBackend(undefined);}
  const used=requests;
  assert.equal((await reviewClipMentorCopy(input,service,undefined,true)).receipt.verdict,'pass','history remains readable with the original verdict');
  await assert.rejects(reviewClipMentorCopy(input,service),/operation_unavailable/);
  assert.equal(requests,used,'changing the required scope cannot resubmit a consumed operation');

  taskPolicy=policy([opening]);
  const visual={kind:'visual',phase:'original',evidence_id:'BT-E001',source_seconds:1.5};
  assert(input.packet.source_evidence.some(item=>item.evidence_id===visual.evidence_id&&item.time_seconds?.includes(1.5)));
  const viaVisual=await reviewClipMentorCopy({...input,operationId:randomUUID()},changed(v=>
   Object.assign(v.copy_units[0].group_checks[0].L1,{evidence:[visual]})));
  assert.equal(viaVisual.receipt.verdict,'pass','ordinary teaching can cite an actual registered visual');
  for(const ref of [{...visual,source_seconds:8},{...visual,evidence_id:'BT-E002',source_seconds:9}]){
   const wrong=await reviewClipMentorCopy({...input,operationId:randomUUID()},changed(v=>
    Object.assign(v.copy_units[0].group_checks[0].L1,{evidence:[ref]})));
   assert.equal(wrong.receipt.verdict,'insufficient_evidence','an in-group timestamp cannot replace the actual evidence time');
  }
  const visualReply=structuredClone(viaVisual.receipt.units[0].group_checks!);
  visualReply.group_reviews![1].L1.evidence=visualReply.group_reviews![0].L1.evidence;
  assert.equal(assessGroupReview(visualReply,currentUnit,true,input.packet.source_evidence).verdict,'insufficient_evidence','registered visual from another group fails');
  const sliced=structuredClone(copy);
  const slicedIr=(sliced.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  const firstExplanation=slicedIr[slicedIr.current_picture_plan].phases[1];
  const lineSource=currentUnit.picture_plan!.line_source_ranges.find(line=>line.line_id===firstExplanation.line_id)!;
  const segment=lineSource.evidence_source_ranges![0];
  const [start,end]=lineSource.source_range_seconds;
  firstExplanation.context_source_ranges=[
   {segment_id:segment.segment_id,source_range_seconds:[start,1],purpose:'first retained slice'},
   {segment_id:segment.segment_id,source_range_seconds:[7,end],purpose:'second retained slice'},
  ];
  const slicedPacket=await copyTeachingPacketFromDoc(sliced);
  const evidenceInGap=structuredClone(viaVisual.receipt.units[0].group_checks!);
  evidenceInGap.group_reviews![0].L1.evidence=[{...visual,phase:'explanation'}];
  assert.equal(assessGroupReview(evidenceInGap,slicedPacket.units[0],true,slicedPacket.source_evidence).verdict,'insufficient_evidence','the explanation envelope does not admit an unselected frame');

  const stillDoc=structuredClone(copy);
  const stillAnalysis=stillDoc.clipMentorAnalysis!,stillLedger=stillAnalysis.source_breakdown!;
  const stillFrame={...stillAnalysis.evidence.find(item=>item.evidence_id==='BT-E001')!,
   evidence_id:'BT-EDGE',time_seconds:10.2,source_frame:306};
  stillAnalysis.evidence.push(stillFrame);
  const originalSegment=stillLedger.segments.find(item=>item.segment_id==='BT-S01')!;
  originalSegment.visible_evidence_ids.push(stillFrame.evidence_id);
  stillLedger.segments.push({...originalSegment,segment_id:'BT-STILL',source_range_seconds:[10.2,11],
   visible_evidence_ids:[stillFrame.evidence_id],claim_evidence_ids:[],interpretation_evidence_ids:[]});
  stillLedger.units[0].explanation_segment_ids.push('BT-STILL');
  const stillInternal=(stillAnalysis.blueprint[0] as any).internal_review;
  stillInternal[stillInternal.current_picture_plan].phases[1].context_source_ranges=[
   {source_range_seconds:[10.2,10.2],segment_id:'BT-STILL',purpose:'Declared supporting still'}];
  const stillPacket=await copyTeachingPacketFromDoc(stillDoc);
  const atEnd=structuredClone(evidenceInGap);
  atEnd.group_reviews![0].L1.evidence=[{kind:'visual',phase:'explanation',source_seconds:10.2,evidence_id:stillFrame.evidence_id}];
  assert.equal(assessGroupReview(atEnd,stillPacket.units[0],true,stillPacket.source_evidence).verdict,'pass','an explicitly planned endpoint still from the registered packet is usable evidence');
  delete stillPacket.units[0].picture_plan!.line_source_ranges[0].context_source_ranges;
  assert.equal(assessGroupReview(atEnd,stillPacket.units[0],true,stillPacket.source_evidence).verdict,'insufficient_evidence','a dynamic half-open endpoint remains excluded');

  // The real adapter archives late raw bytes after cancellation. Turn over the
  // active requirement before readback and keep the original result auditable.
  const lateInput={...input,operationId:randomUUID()};
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const controller=new AbortController();
  const late=reviewClipMentorCopy(lateInput,{...service,run:async()=>{requests++;entered.resolve();await release.promise;return reply;}},controller.signal);
  await entered.promise;controller.abort();
  const settled=assert.rejects(late,/review_cancelled_or_timed_out/);
  release.resolve();await settled;
  const {readSavedExternalResponse}=await import('../../server/clipmentor/external-call');
  for(let i=0;i<50&&!await readSavedExternalResponse(root,lateInput.operationId);i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert(await readSavedExternalResponse(root,lateInput.operationId),'the late raw review really reached durable storage');
  taskPolicy=policy([{...opening,quote:'New live requirement'}]);
  const recovered=await reviewClipMentorCopy(lateInput,service,undefined,true);
  assert(recovered.cached);assert.equal(recovered.receipt.verdict,'pass');
  assert.equal(recovered.receipt.opening_comparison_digest,positive.receipt.opening_comparison_digest);
  const consumed=requests;
  await assert.rejects(reviewClipMentorCopy(lateInput,service),/operation_unavailable/);
  assert.equal(requests,consumed);
  const lateCompleted={...input,operationId:randomUUID()};
  taskPolicy=policy([opening]);
  await assert.rejects(reviewClipMentorCopy(lateCompleted,{...service,run:async()=>{
   requests++;taskPolicy=policy([{...opening,quote:'Superseded while active'}]);return reply;
  }}),/review_requirements_changed/);
  assert.equal((await reviewClipMentorCopy(lateCompleted,service,undefined,true)).receipt.verdict,'pass','the stale result survives as an original historical receipt');
  const beforePrepare=requests;
  const preparing={...input,operationId:randomUUID()};
  taskPolicy=policy([opening]);
  await assert.rejects(reviewClipMentorCopy(preparing,{...service,frame:async()=>{
   taskPolicy=policy([{...opening,quote:'Changed during source frame preparation'}]);
   return Buffer.from('synthetic image').toString('base64');
  }}),error=>{
   const diagnostic=(error as {diagnostic?:{requestsAttempted?:number;code?:string}}).diagnostic;
   return diagnostic?.code==='review_requirements_changed'&&diagnostic.requestsAttempted===0;
  });
  assert.equal(requests,beforePrepare,'a known obsolete review does not submit after preparation');
  const {confirmedUnsubmittedGateway}=await import('../../server/clipmentor/production-recovery');
  const unsubmittedBody={projectId:input.projectId,diagnostic:{code:'review_requirements_changed',stage:'reservation',
   requestsAttempted:0,retryable:false,operationId:preparing.operationId}};
  assert(confirmedUnsubmittedGateway('review',{body:unsubmittedBody},preparing.operationId,input.projectId));
  assert(!confirmedUnsubmittedGateway('review',{body:unsubmittedBody},randomUUID(),input.projectId));
  assert(!confirmedUnsubmittedGateway('review',{body:unsubmittedBody},preparing.operationId,'other-project'));
  assert(!confirmedUnsubmittedGateway('review',{body:{...unsubmittedBody,diagnostic:{...unsubmittedBody.diagnostic,requestsAttempted:1}}},preparing.operationId,input.projectId));
  const unsubmitted=requests;
  const {CopyReviewError}=await import('../../server/clipmentor/copy-review');
  await assert.rejects(reviewClipMentorCopy({...input,operationId:randomUUID(),packet:{...input.packet,delivery_sections:undefined}},service),
   error=>error instanceof CopyReviewError&&error.diagnostic.code==='opening_comparison_section_missing'&&error.diagnostic.requestsAttempted===0);
  assert.equal(requests,unsubmitted);
  const fixed={...opening,results:{views:'339.32k',units:'135',revenue:'RM5.31k'}};
  const fixedQuestion='kenapa video ini capai 339.32k tontonan, 135 unit terjual dan Revenue RM5.31k?';
  const fixedInvitation='Jom tengok caranya.';
  const fixedCurrent=await makeCurrent(`${premise}, tapi ${fixedQuestion} ${fixedInvitation}`);
  const fixedReply=structuredClone(reply);
  const openingCheck=fixedReply.delivery_checks[0];
  assert('opening_comparison' in openingCheck);
  Object.assign(openingCheck.opening_comparison,{
   same_product_quote:premise+', tapi',outcome_question_quote:fixedQuestion,invitation_quote:fixedInvitation});
  Object.assign(fixedReply.delivery_checks[1],{ending_picture:{asset_id:sections[1].picture.asset_id,view:'planned_composition',both_visible:'yes',observation:'Fixture reply'}});
  const fixedService={...service,requirements:async()=>({policy:policy([fixed]),opening:fixed}),async run(prompt:string){
   requests++;assert(prompt.includes('opening_comparison.invitation_quote'));return fixedReply;
  }};
  const fixedAccepted=await reviewClipMentorCopy(fixedCurrent.input,fixedService);
  assert.equal(fixedAccepted.receipt.verdict,'pass','an ordinary Malay connector remains possible inside the anchored opening');
  const savedPath=join(root,`${fixedCurrent.input.operationId}.json`);
  const historical=JSON.parse(await readFile(savedPath,'utf8'));
  delete historical.raw_review.delivery_checks[0].opening_comparison.invitation_quote;
  delete historical.result.receipt.delivery_checks[0].opening_comparison.invitation_quote;
  await writeFile(savedPath,JSON.stringify(historical));
  const spentFixed=requests;
  await assert.rejects(reviewClipMentorCopy(fixedCurrent.input,fixedService),/review_requirements_changed/);
  assert.deepEqual((await reviewClipMentorCopy(fixedCurrent.input,fixedService,undefined,true)).receipt,historical.result.receipt);
  assert.equal(requests,spentFixed);
  console.log('Content contract: current comparison, retained verdict, no extra requests, grouped L1 and visual/source controls; zero real providers.');
 }finally{await rm(root,{recursive:true,force:true});}
}

const nativeFetch=globalThis.fetch;let voiceRequests=0;
globalThis.fetch=(async()=>{voiceRequests++;return new Response(JSON.stringify({path:'/media/uploads/synthetic-voice.mp3',durationSeconds:3}),{status:200,headers:{'Content-Type':'application/json'}});})as typeof fetch;
try{const{submitVoice}=await import('../generate/voice');const generated=await submitVoice({provider:'minimax',voiceId:'test-voice',text:'Approved new opening.',speed:1},t);assert.equal((generated.props?.generation as any).text,'Approved new opening.');assert.equal((generated.props?.generation as any).durationSeconds,3);assert.equal(voiceRequests,1);}finally{globalThis.fetch=nativeFetch;}
console.log('Delivery sections: still/evidence/copy/voice binding, unchanged teaching gate, offsets, missing/stale/negative controls, original fake service save/read passed; zero real provider calls.');
