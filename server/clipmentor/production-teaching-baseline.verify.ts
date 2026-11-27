import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer,type RequestListener } from 'node:http';
import { execFileSync } from 'node:child_process';
import fixture from './fixtures/judydoll-teaching-baseline-r9.json';
import narrationCounterexample from './fixtures/judydoll-final-narration-v3-d00da4d8.json';
import selectionFixture from './fixtures/judydoll-teaching-selection.json';
import exemplars from './fixtures/exemplar-teaching-comparison-20261121.json';
import humanTeachingCalibration from './fixtures/human-teaching-calibration.json';
import teachingPurpose from '../../src/agent/skills/clipmentor/references/teaching-purpose.json';
import accepted from '../../src/clipmentor/fixtures/production-saved-projects-20261028.json';
import { projectDoc } from '../external-agent/offline-runtime.verify-fixtures';
import type { ProjectDoc } from '../../src/editor/types';
import type { AnalysisEvidence,ClipMentorAnalysis } from '../../src/clipmentor/analysis';
import type { SourceBreakdown } from '../../src/clipmentor/source-breakdown';
import type { ProductionInput,ProductionTask } from './production-task';
import { confirmedOpeningResultsMatch,deliveryReview,type DeliverySection } from '../../src/clipmentor/delivery-sections';

const path=await mkdtemp(join(tmpdir(),'teaching-baseline-'));
const prior=process.env.OPENCHATCUT_DATA_DIR,realFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=path;
let calls:string[]=[];
let analysisCorrection:SourceBreakdown|undefined;
let rejectSupplement:false|'small'|'archived'=false;
let supplementArchiveId:string|undefined;
let reviewAction:'repeat'|'reject-paraphrase'|undefined;
let narrationAction:'missing'|'wrong-quote'|'missing-basis'|'same-finding'|'missing-criterion'|'new-criterion'|'partial-criterion'|'no-claim-quote'|'bare-unit'|'cited-fact'|'cited-teaching'|undefined;
let wholeFilmAction:'missing'|'omission'|'selection-omission'|undefined;
let unexpectedInitialFeedbackScope=false;
let panelRequest:RequestListener|undefined;
const authorPrompts=new Map<string,string>();
const independentPrompts:string[]=[];
const draftLine={id:'fixture-line',point_ids:['fixture-point'],narration_ms:'Berus ini menyentuh sisi hidung.',
 caption_lines:['Berus ini menyentuh sisi hidung.'],zh:'刷子碰到鼻侧。',source_seconds:[0,4.5],labels:[]};
const firstDraft={source_candidate_id:null,candidate_id:'script_candidate_first',plan_id:'picture_plan_first',
 line_guidance:'回看同组原片。',lines:[draftLine],plan:{
  phases:[
   {mode:'original',source_range_seconds:[0,4.5],picture:'保留原片',evidence_ids:['fixture-visual']},
   {mode:'explanation',line_id:draftLine.id,source_range_seconds:[0,4.5],picture:'回看本组',evidence_ids:['fixture-visual'],
    context_source_ranges:[{segment_id:'fixture-segment',source_range_seconds:[0,4.5],purpose:'本组证据'}]},
  ],
  viewer_stage_cues:{original:{text:'Video asal',enter:'原片开始时',exit:'原片结束时'},
   revisit:[{line_ids:[draftLine.id],text:'Ulasan',enter:'解说开始时',exit:'解说结束时'}]},
  selected_narration:[draftLine],
 }};
let draftAttempt:{
 change?:Record<string,unknown>;
 receipts:Array<{ok?:boolean;revision?:number;error?:string}>;
 skillText?:string;
}|undefined;
const host=createServer(async(req,res)=>{
 if(panelRequest&&req.url?.startsWith('/api/clipmentor/production-task?')){
  panelRequest(req,res);return;
 }
 const chunks:Buffer[]=[];
 for await(const chunk of req)chunks.push(Buffer.from(chunk));
 const body=JSON.parse(Buffer.concat(chunks).toString()) as {messages:Array<{role:string;content:string}>};
 const data=JSON.parse(body.messages.find(message=>message.role==='user')!.content);
 const stream=()=>{
  res.writeHead(200,{'content-type':'text/event-stream'});
  return (delta:unknown,finish_reason:string|null)=>res.write('data: '+JSON.stringify({id:'teaching-check-fixture',
   object:'chat.completion.chunk',created:0,model:'baseline-fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
 };
 if(!data.units||!data.purpose){
  if(['analysis','blueprint'].includes(data.stage)&&!authorPrompts.has(data.stage)){
   authorPrompts.set(data.stage,JSON.stringify(body.messages));
  }
  if(data.stage==='blueprint'&&draftAttempt){
   calls.push('draft');
   const send=stream();
   const returned=body.messages.filter(message=>message.role==='tool');
   const previous=returned.at(-1);
   const write={action:'set_copy_candidate',id:'fixture-group',record:firstDraft};
   let tool:{name:string;args:Record<string,unknown>}|undefined;
   if(!previous){
    tool={name:'load_skill',args:{name:'clipmentor',file:'references/pre-edit-analysis.md',limit:48001}};
   }else{
    if(returned.length===1)draftAttempt.skillText=previous.content;
    else draftAttempt.receipts.push(JSON.parse(previous.content));
    const change=draftAttempt.change;
    if(returned.length===1||returned.length===2&&change){
     const expectedRevision=returned.length===1?data.revision:draftAttempt.receipts[0].revision??data.revision;
     tool={name:'revise_clipmentor_analysis',args:{...(returned.length===1&&change?change:write),
      actor:data.actor,expectedRevision,reason:'假服务检查基线与首稿保存'}};
    }
   }
   if(tool){
    send({role:'assistant',tool_calls:[{index:0,id:'call_draft_'+returned.length,type:'function',
     function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]},null);
    send({},'tool_calls');
   }else{
    send({role:'assistant',content:'本地写稿夹具结束。'},null);send({},'stop');
   }
   res.end('data: [DONE]\n\n');return;
  }
  if(data.stage==='analysis'&&analysisCorrection){
   calls.push('analysis');
   const send=stream();
   const toolReplies=body.messages.filter(message=>message.role==='tool');
   if(rejectSupplement&&toolReplies.length===1){
    const status='operator_provided_not_independently_verified';
    const evidence=rejectSupplement==='small'?[
     {kind:'operator_supplied',status,source_ids:[]},
    ]:Array.from({length:100},(_,i)=>({evidence_id:'image-row-'+i,kind:'operator_supplied',status,
     text:'Refers to a non-image asset',source_ids:['video-fixture-id'],supporting_evidence_ids:[]}));
    if(rejectSupplement==='archived')evidence[0]={...evidence[0],evidence_id:'api_key:fixture-standin'};
    const args={action:'append',expectedRevision:data.revision+1,reason:'补充已上传图片说明',
     actor:{operator:'fixture',executor:'builtin_api_agent',instruction:'核对素材',identity:'local_declared_not_authenticated'},
     records:{evidence}};
    send({role:'assistant',tool_calls:[{index:0,id:'call_supplement',type:'function',function:{name:'revise_clipmentor_analysis',arguments:JSON.stringify(args)}}]},null);
    send({},'tool_calls');
   }else if(rejectSupplement==='archived'&&toolReplies.length===2){
    const receipt=JSON.parse(toolReplies.at(-1)!.content);
    assert.equal(receipt.archived,true);
    assert.match(receipt.error,/source_ids:.*nothing changed/);
    assert(!receipt.error.includes('fixture-standin'));
    supplementArchiveId=receipt.artifactId;
    send({role:'assistant',tool_calls:[{index:0,id:'call_details',type:'function',function:{name:'read_agent_artifact',
     arguments:JSON.stringify({artifactId:supplementArchiveId,pointer:'/evidence_issues/99'})}}]},null);
    send({},'tool_calls');
   }else if(toolReplies.length){
    if(rejectSupplement==='archived')assert.equal(JSON.parse(JSON.parse(toolReplies.at(-1)!.content).content).evidence_id,'image-row-99');
    send({role:'assistant',content:'已保存教学选题。'},null);send({},'stop');
   }else{
    const args={action:'set_source_breakdown',expectedRevision:data.revision,record:analysisCorrection,reason:'按现场原片证据修订购买关注与作用',
     actor:{operator:'fixture',executor:'builtin_api_agent',instruction:'用户要求修正教学方向',identity:'local_declared_not_authenticated'}};
    send({role:'assistant',tool_calls:[{index:0,id:'call_baseline',type:'function',function:{name:'revise_clipmentor_analysis',arguments:JSON.stringify(args)}}]},null);
    send({},'tool_calls');
   }
   res.end('data: [DONE]\n\n');return;
  }
  calls.push('author');
  res.writeHead(400,{'content-type':'application/json'});
  res.end(JSON.stringify({error:{message:'author transport reached; fixture stops here'}}));
  return;
 }
 calls.push('baseline');
 independentPrompts.push(JSON.stringify(body.messages));
 const fail=data.units[0].points[0].teaching_question===fixture.source_breakdown.points[0].teaching_question.normalize('NFKC');
 const mainPoint=data.units.flatMap((unit:any)=>unit.points).find((point:any)=>point.role==='primary');
 const mainEvidence=data.evidence.find((entry:any)=>mainPoint?.teaching_basis?.evidence_ids.includes(entry.id));
 const missingEvidenceId=wholeFilmAction==='omission'?'fixture-unselected-result':wholeFilmAction==='selection-omission'?'V-hook':undefined;
 const wholeEvidence=missingEvidenceId?data.evidence.find((entry:any)=>entry.id===missingEvidenceId):mainEvidence;
 const verdict={
  ...(unexpectedInitialFeedbackScope?{feedback_scope:'baseline'}:data.feedback?{feedback_requires_baseline:fail}:{}),summary:'ok',
  ...(data.pointReview&&wholeFilmAction!=='missing'?{whole_film:{
   status:missingEvidenceId?'fix':'ok',main_point_id:mainPoint.point_id,
   focus:'在相同参照下判断落点或关系',alternative:'单独解释包装和产品辨认',
   reason:missingEvidenceId?'原片另有买家需要的结果，逐个动作成立仍不能替代这段解释。':'该组选点比单独介绍产品更能回答具体购买疑问。',
   evidence_id:wholeEvidence.id,source_quote:wholeEvidence.text,
   affected_unit_ids:missingEvidenceId?[data.units[0].unit_id]:[],
  }}:{}),
  ...(data.narrationTargets?.length&&narrationAction!=='missing'?{narration_checks:data.narrationTargets.map((target:any)=>{
   const line=target.lines[0];
   const point=data.units.find((unit:any)=>unit.unit_id===target.unit_id).points.find((item:any)=>item.point_id===target.point_id);
   const criterion=(field:'connection'|'claim_limit')=>narrationAction==='missing-criterion'?{}:{baseline_criterion:{
    field,quote:narrationAction==='new-criterion'?'必须在开场报出鼻侧颜色。':
     narrationAction==='partial-criterion'?point.teaching_basis[field].slice(0,5):point.teaching_basis[field]}};
   if(data.selection&&line?.narration===selectionFixture.inferenceDraft)return {unit_id:target.unit_id,point_id:target.point_id,
    status:'fix',line_id:line.line_id,quote:line.narration,reason:'把吸引观众的剪辑动机写成了已观察的事实。',...criterion('claim_limit')};
   if(narrationAction==='no-claim-quote')return {unit_id:target.unit_id,point_id:target.point_id,
    status:'fix',reason:'口播把结果归给具体色号。',...criterion('claim_limit')};
   if(narrationAction==='cited-fact'||narrationAction==='cited-teaching')return {
    unit_id:target.unit_id,point_id:target.point_id,status:'fix',line_id:line.line_id,quote:line.narration,
    reason:narrationAction==='cited-fact'?'越出了画面所能支持的说法。':'只描述了当时的画面。',
    ...criterion(narrationAction==='cited-fact'?'claim_limit':'connection')};
   const counterexample=narrationAction==='same-finding'?narrationCounterexample.items[1]
    :narrationCounterexample.items.find(item=>item.narration_ms===line?.narration);
   if(counterexample&&(!narrationAction||['same-finding','missing-criterion','new-criterion','partial-criterion'].includes(narrationAction))||!line)
    return {unit_id:target.unit_id,point_id:target.point_id,status:'fix',
     reason:'基线有、口播没有：'+(counterexample?.learner_gap??'未登记实际口播。'),...criterion('connection')};
   const palette=line.narration.includes('kod masing-masing');
   return {unit_id:target.unit_id,point_id:target.point_id,status:'ok',
    decision:palette?'达人在同一镜头摆两盘供看差别':'达人把刷头退开后的结果留在镜头中。',
    ...(narrationAction==='missing-basis'?{}:{viewer_basis:palette
     ?'观众可以把色差对回两个编号。':'观众能判断无遮挡时鼻侧色痕有多明显。'}),
    line_id:line.line_id,
    quote:narrationAction==='wrong-quote'?'这句只存在于策划备注里。':line.narration,
    reason:'口播已经交代何时收镜和买家届时能看到什么结果。'};
  })}:{}),
  units:data.units.map((unit:any)=>({
   unit_id:unit.unit_id,status:fail||narrationAction==='bare-unit'?'fix':'ok',source_role:fail?'展示动作未说明教学功能':'以相同参照让受众判断差异',
   takeaway:fail?'需要回到原片确认怎样呈现购买理由':'达人可学走把观察对象和比较结果放在一起的拍法',
   evidence_ids:[data.evidence.find((e:any)=>unit.source_ranges.some(([a,b]:number[])=>e.range[0]>=a&&e.range[0]<b))?.id].filter(Boolean),
   reason:fail?'教学基线遗漏了原片承接和观众要判断的问题。':'人工标注的符合样本',
   ...(data.pointReview?{point_checks:unit.points.map((point:any)=>{
    assert(!('exemplar' in point.teaching_basis||'difference' in point.teaching_basis),'reviewer cannot receive author exemplar labels');
    const evidence=data.evidence.find((item:any)=>point.teaching_basis.evidence_ids.includes(item.id))!;
    const connection=reviewAction==='repeat'?evidence.text:point.teaching_basis.connection;
    return {point_id:point.point_id,status:reviewAction==='reject-paraphrase'?'fix':'ok',learner_takeaway:connection,
     connection,question_quote:point.teaching_question,source_evidence_id:evidence.id,source_quote:evidence.text,
     visual_check:'Read the planned visible action',omission_loss:'Visual comparison remains observable'};
   })}:{}),
  })),
 };
 const send=stream();
 send({role:'assistant',content:'\x60\x60\x60json\n'+JSON.stringify(verdict)+'\n\x60\x60\x60'},null);
 send({},'stop');res.end('data: [DONE]\n\n');
});
try{
 await new Promise<void>((resolve,reject)=>{host.once('error',reject);host.listen(0,'127.0.0.1',resolve);});
 const address=host.address();assert(address&&typeof address!=='string');
 const origin='http://127.0.0.1:'+address.port;
 globalThis.fetch=async(input,options)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  assert.equal(url.href,origin+'/llm/chat/completions','no real provider or other service permitted');
  return realFetch(input,options);
 };
 const {runtimeProfile}=await import('../runtime-profile');
 assert.equal(runtimeProfile().rootDir,path,'test must never initialize the project store against the operator profile');
 const {activateOfflineAgentRuntimeBackend}=await import('../external-agent/agent-runtime-persistence');
 activateOfflineAgentRuntimeBackend();
 const {panelOpeningComparison}=await import('./production-panel-delivery');
 const {setStoredEntry}=await import('../plugins/project-store');
 const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
 const {productionStageWorker,productionAuthorTaskData}=await import('./production-worker');
 const {advanceProductionTask,createProductionTask,queueDraftBlueprintFeedback,productionTaskStore,panelBlueprintRequirementsDigest}=await import('./production-task');
 const {revisionOf}=await import('../../src/agent/external-edit-session');
 const {digestValue}=await import('../agent-runs/store-values');
 const {checkTeachingBaseline,teachingBaselineSource,validateTeachingBaselineReview,teachingRebuild,staleRebuiltTeaching,
  unchangedRejectedTeaching,unchangedWholeFilmTeaching,teachingDraftPointersDigest,teachingBaselineDigest,retireTeachingDrafts,newlyChangedTeaching,teachingPointGaps,
  confirmedTeachingDigest,teachingDefinitionDigest,qualifiedTeachingDigest,rejectsTeachingDirection}=await import('./production-teaching-baseline');
 const {copyPreparationReady,checkSourceBreakdown,breakdownPointEvidence}=await import('../../src/clipmentor/source-breakdown');
 const old=projectDoc(1080,1920);
 old.assets=[{id:'source',kind:'video',src:'/media/uploads/judy-fixture.mp4',name:'fixture',durationInFrames:2020,width:1080,height:1920,sourceContentHash:'a'.repeat(64)}];
 old.clipMentorAnalysis={schema_version:1,analysis_id:'revision-9-fixture',revision:9,import_origin:'isolated_fixture',
  audit:[],reviews:[],...structuredClone(fixture)} as unknown as ClipMentorAnalysis;
 const {copyTeachingPacketFromDoc,copyReviewSubject}=await import('../../src/clipmentor/production-gate');
 const {productionRepairTargets,productionAuthorSelfCheckSource,validateAuthorSelfCheck}=await import('./production-author-self-check');
 const rawPacket=await copyTeachingPacketFromDoc(old);
 const subject=await copyReviewSubject(old);
 const repairReview=productionRepairTargets({repairContext:{repair:{status:'bound',units:[{unit_id:'U-02',findings:[
  {finding_id:'original-U02',quote:'Old disputed copy',reason:'Explain what the picture supports'},
 ]}]}}},rawPacket);
 const repairSource={...productionAuthorSelfCheckSource(old,{rawPacket,reviewed:{subject}},[],true),repairReview};
 const [group1,group2]=rawPacket.units;
 assert.deepEqual(group1.source_context!.evidence_ids,group2.source_context!.evidence_ids,'real full-source packets share context');
 const own=group2.lines[0].narration_ms;
 const firstGroupQuote=repairSource.sourceEvidence!.find(e=>e.evidence_id==='VIS-1-1')!.text;
 const secondGroupQuote=repairSource.sourceEvidence!.find(e=>e.evidence_id==='VIS-3-1')!.text;
 assert(group2.source_context!.evidence_ids.includes('VIS-1-1'),'G1 observation is readable as G2 context');
 const answers=Array.from({length:7},(_,i)=>({id:'S'+(i+1),status:'ok',reference:own,reason:'fixture'}));
 const answerWith=(quote:string)=>JSON.stringify(answers.map(answer=>answer.id==='S2'?{...answer,repair_resolutions:[
  {finding_id:'original-U02',status:'resolved',reference:[quote],reason:'fixture'},
 ]}:answer));
 assert.equal(validateAuthorSelfCheck(answerWith(own),repairSource)[1].status,'ok');
 assert.equal(validateAuthorSelfCheck(answerWith(secondGroupQuote),repairSource)[1].status,'ok');
 assert.throws(()=>validateAuthorSelfCheck(answerWith(firstGroupQuote),repairSource),/repair_reference/,
  'a G1 observation supplied as full context cannot resolve G2');
 console.log('PASS JUDYDOLL G2 can cite its original observation, but shared full-source context cannot close a finding with G1 evidence');
 const taskFor=async(projectId:string,doc:ProjectDoc,maxRepairs=0,editorialPolicy?:'exemplar-v1')=>{
  await setStoredEntry('project:'+projectId,doc);
  const saved=(await loadOfflineStoredProject(projectId))!;
  const input:ProductionInput={projectId,sourceAssetId:doc.clipMentorAnalysis!.source.asset_id,product:doc.clipMentorAnalysis!.product,
   brief:doc.clipMentorAnalysis!.source_breakdown!.review_scope!.instruction!,author:{provider:'openai',model:'baseline-fixture',origin,apiMode:'chat'},
   reviewer:{provider:'openai',model:'independent-must-not-run',origin,apiMode:'chat'},humanBlueprintReview:true,
   panelDelivery:{productAssetId:'product',productAssetHash:'b'.repeat(64),salesAssetId:'sales',ctaAssetId:'cta',ctaAssetHash:'c'.repeat(64),editorialPolicy},
   budget:{model:6,review:0,observation:0,tts:0,render:0,preview_review:0,maxRepairs,maxElapsedMs:120_000}};
  const task=await createProductionTask(input);
  task.projectRevision=saved.revision;task.stage='blueprint';
  task.completed.analysis={at:Date.now(),artifact:{revision:saved.revision}};
  await productionTaskStore.save(task);
  return task;
 };
 const firstCopyDoc=projectDoc(1080,1920);
 const visible:AnalysisEvidence={evidence_id:'fixture-visual',kind:'visible_action',text:'刷子与鼻侧同框。',
  status:'agent_observed_candidate',source_range_seconds:[0,3.5],supporting_evidence_ids:[],source_ids:[],
  call_status:'unknown',observation_method:'isolated_visible_excerpt_fixture'};
 const breakdown:SourceBreakdown={version:1,review_scope:{kind:'full_source',instruction:'核对鼻侧拍法。'},
  segments:[{segment_id:'fixture-segment',source_range_seconds:[0,4.5],visible_evidence_ids:[visible.evidence_id],
   claim_evidence_ids:[],interpretation_evidence_ids:[],unknowns:[]}],
  points:[{point_id:'fixture-point',segment_ids:['fixture-segment'],buying_concern:'观察修容位置',
   teaching_question:'为什么这一镜能让买家分辨刷子落在鼻侧哪一处？',filming_conditions:['刷子和鼻侧同框'],
   role:'primary',importance:'must_explain',teaching_basis:{selling_point:'刷子落点可见',evidence_ids:[visible.evidence_id],
    method:visible.text,connection:'买家能按鼻尖位置辨认落点。',must_capture:'刷子和面部的位置关系。',
    claim_limit:'仅描述可见落点。',exemplar:'buyer-first',difference:'证据取自本组。'}}],
  units:[{unit_id:'fixture-group',original_segment_ids:['fixture-segment'],original_source_ranges:[[0,4.5]],
   explanation_segment_ids:['fixture-segment'],coverage:[{point_id:'fixture-point',treatment:'explain',role:'primary'}],
   revisits:[{from_segment_id:'fixture-segment',to_segment_id:'fixture-segment',reason:'回看刷子位置。'}]}]};
 firstCopyDoc.assets=[{...old.assets[0],durationInFrames:135}];
 firstCopyDoc.clipMentorAnalysis={schema_version:1,analysis_id:'first-copy-fixture',revision:1,import_origin:'isolated_fixture',
  source:{asset_id:'source',sourceContentHash:'a'.repeat(64),fps:30,duration_seconds:4.5},product:{name:'Fixture palette',category:'修容盘'},
  evidence:[visible],transcripts:[],reviews:[],audit:[],source_breakdown:breakdown,
  points:[{point_id:'fixture-point',unit_id:'fixture-group',source_range_seconds:[0,4.5],buying_reason_or_function:'辨认落点',
   filming_conditions:['刷子和鼻侧同框'],evidence_ids:[visible.evidence_id],uncertainties:[],required:true,
   explanation_priority:'辅助于整片理解',status:'candidate',review_status:'pending',provenance:'fixture'}],
  blueprint:[{unit_id:'fixture-group',point_ids:['fixture-point'],intent_zh:'辨认落点',line_guidance:'本组原窗。'}]};
 const revisedBreakdown=structuredClone(breakdown);
 revisedBreakdown.points[0].teaching_question='为什么同框能让买家区分落点和周围皮肤？';
 revisedBreakdown.points[0].change_reason='从原片补核落点和周围皮肤的关系。';
 const replayOnly=structuredClone(breakdown);
 replayOnly.units[0].original_source_ranges=[[0,4.48]];
 const wrongEvidence=structuredClone(breakdown);
 wrongEvidence.points[0].teaching_basis!.evidence_ids=['fixture-unrelated'];
 wrongEvidence.points[0].change_reason='替换该教学点引用的原片依据。';
 wrongEvidence.segments[0].visible_evidence_ids.push('fixture-unrelated');
 for(const scenario of [
  {label:'unchanged'},
  {label:'definition',change:{action:'set_source_breakdown',record:revisedBreakdown}},
  {label:'evidence',change:{action:'revise',collection:'evidence',id:visible.evidence_id,record:{...visible,text:'刷子与鼻翼边缘同框。'}}},
  {label:'evidence binding',change:{action:'set_source_breakdown',record:wrongEvidence}},
  {label:'replay window',change:{action:'set_source_breakdown',record:replayOnly}},
  {label:'unrelated evidence',change:{action:'revise',collection:'evidence',id:'fixture-unrelated',
   record:{...visible,evidence_id:'fixture-unrelated',text:'补充观察。'}}},
  {label:'legacy',legacy:true},
 ]){
  const doc=structuredClone(firstCopyDoc);
  doc.clipMentorAnalysis!.evidence.push({...visible,evidence_id:'fixture-unrelated',text:'未被教学点引用的记录。'});
  const task=await taskFor('teaching-first-copy-'+scenario.label.replace(' ','-'),doc,0,scenario.legacy?undefined:'exemplar-v1');
  const before=(await loadOfflineStoredProject(task.projectId))!;
  draftAttempt={change:scenario.change,receipts:[]};
  calls=[];
  await advanceProductionTask(task,productionStageWorker);
  const attempt=draftAttempt;
  draftAttempt=undefined;
  assert.deepEqual(calls,['baseline',...Array(scenario.change?4:3).fill('draft')],scenario.label);
  const after=(await loadOfflineStoredProject(task.projectId))!;
  const saved=after.doc.clipMentorAnalysis!.blueprint[0] as {internal_review?:Record<string,unknown>};
  if(scenario.change){
   assert.equal(attempt.receipts[0].ok,true,`the ${scenario.label} change must actually apply first: ${JSON.stringify(attempt.receipts[0])}`);
   assert.equal(after.doc.clipMentorAnalysis!.audit.some(entry=>entry.action===scenario.change!.action
    &&entry.revision===attempt.receipts[0].revision),true);
  }
  const copyReceipt=attempt.receipts.at(-1)!;
  if(['definition','evidence','evidence binding'].includes(scenario.label)){
   assert.equal(copyReceipt.error,'teaching_baseline_changed_before_copy');
   assert.equal(saved.internal_review?.current_script_candidate,undefined);
   assert.equal(saved.internal_review?.current_picture_plan,undefined);
   assert.notEqual(confirmedTeachingDigest(after.doc),confirmedTeachingDigest(before.doc));
   assert.equal(teachingDefinitionDigest(after.doc)===teachingDefinitionDigest(before.doc),scenario.label==='evidence');
  }else{
   assert.equal(copyReceipt.ok,true,JSON.stringify(copyReceipt));
   assert(attempt.skillText?.includes('为什么这样拍有助于买家判断这个购买关注点？'),
    'the production author receives the buyer-judgment question through load_skill');
   assert(!attempt.skillText.includes('这项拍法怎样把这个购买关注展示清楚'));
   assert.equal(saved.internal_review?.current_script_candidate,firstDraft.candidate_id);
   assert.equal(saved.internal_review?.current_picture_plan,firstDraft.plan_id);
   const candidate=saved.internal_review?.[firstDraft.candidate_id] as {lines:unknown}|undefined;
   assert.deepEqual(candidate?.lines,firstDraft.lines);
   assert.notEqual(after.revision,before.revision);
   assert.equal(qualifiedTeachingDigest(after.doc),qualifiedTeachingDigest(before.doc));
  }
  if(scenario.label==='replay window'){
   const next={...task,stage:'blueprint' as const,repairs:task.repairs+1};
   const sameApproval=await checkTeachingBaseline(next,{signal:new AbortController().signal,
    async effect(){throw Error('a replay-only edit must reuse the existing selection review');}},
   teachingBaselineSource(after.doc,next,[]),panelBlueprintRequirementsDigest(null),qualifiedTeachingDigest(after.doc));
   assert.equal(sameApproval.review.whole_film?.status,'ok');
  }
 }
 console.log('PASS qualified first copy saves on the unchanged project and rejects real definition or same-ID evidence changes');
 for(const [feedback,rewind] of [
  ['第1组教学方向是错的。',true],
  ['第1组教错了。',true],
  ['不是字幕的问题而是教学方向错了。',true],
  ['不是说，教学方向错了，只改字幕。',false],
  ['只把“第1组，教学方向错了。”这句字幕删掉。',false],
  ['字幕箭头方向错了，只把箭头改向右。',false],
  ['不用判断是方向错了还是字幕错了，只改字幕。',false],
  ['【教错了】四字删掉。',false],
  ['这组教学方向错了。',false],
  ['第1组教错了吗',false],
 ] as const)assert.equal(rejectsTeachingDirection(feedback),rewind,feedback);
 const {createMiniConnect}=await import('../../desktop/mini-connect');
 const {clipMentorProductionPlugin}=await import('../plugins/clipmentor-production');
 const {ffmpegBin}=await import('../media-binaries');
 const {uploadDir:fixtureMediaDir}=await import('../media-dir');
 const sourceName='qualification-fixture.mp4',sourcePath=join(fixtureMediaDir(),sourceName);
 await mkdir(fixtureMediaDir(),{recursive:true});
 execFileSync(ffmpegBin(),['-v','error','-y','-f','lavfi','-i','color=size=108x192:rate=30:duration=4.5','-c:v','libx264',sourcePath]);
 const {sha256File}=await import('../../shared/node-content-hash');
 const withCopy=(await loadOfflineStoredProject('teaching-first-copy-unchanged'))!.doc;
 const sourceHash=await sha256File(sourcePath);
 const boardDoc=JSON.parse(JSON.stringify(withCopy).replaceAll('a'.repeat(64),sourceHash).replaceAll('judy-fixture.mp4',sourceName)) as ProjectDoc;
 // The positive is a controlled rewrite of the same teaching point and source evidence.
 const descriptive=narrationCounterexample.items[1].narration_ms;
 const actionable='Jangan tamatkan syot masa berus masih menutup sisi hidung. Tahan syot sampai berus beralih supaya pembeli boleh nilai sendiri betapa ketaranya kesan coklat itu.';
 const narrationDoc=(spoken:string,palette=false)=>{
  const doc=structuredClone(boardDoc);
  doc.clipMentorAnalysis!.source_breakdown!.units[0].coverage[0].reason='提前切走会丢失刷头离开后的鼻侧色痕。';
  const candidate=(doc.clipMentorAnalysis!.blueprint[0] as {internal_review:Record<string,any>}).internal_review;
  const line={narration_ms:spoken,caption_lines:[spoken]};
  Object.assign(candidate[candidate.current_script_candidate].lines[0],line);
  for(const selected of candidate[candidate.current_picture_plan]?.selected_narration??[])Object.assign(selected,line);
  if(palette){
   const analysis=doc.clipMentorAnalysis!;
   analysis.source_breakdown!.units[0].coverage[0].reason='分别介绍两盘会让买家依赖上一镜的记忆来比。';
   analysis.evidence[0].text='两盘打开且编号和色格同框。';
   const point=analysis.source_breakdown!.points[0];
   point.teaching_question='为什么把编号和两盘色格留在同一镜头？';
   point.buying_concern='怎么把盘色和编号准确对上？';
   Object.assign(point.teaching_basis!,{selling_point:'两盘棕色格色调不同',method:'两盘打开并保留对应编号',
    connection:'买家可以在同一画面反复比较，无需跨镜头记颜色。'});
  }
  return doc;
 };
 const runNarration=(id:string)=>({
  signal:new AbortController().signal,
  effect:async<T>(_kind:unknown,_key:unknown,work:(id:string)=>Promise<T>)=>work(id),
 });
 const description=narrationDoc(descriptive);
 const badNarrationTask=await taskFor('teaching-final-narration-description',description,0,'exemplar-v1');
 badNarrationTask.stage='copy_review';
 calls=[];
 const narrationReject=await productionStageWorker(badNarrationTask,runNarration('fixture-narration-no'));
 assert.equal(narrationReject.repair,'blueprint');
 assert.match(String(narrationReject.artifact.teaching_baseline_issue),/基线有、口播没有/);
 assert.equal(narrationReject.artifact.teaching_rebuild,undefined,'a supported baseline is preserved');
 assert.deepEqual(calls,['baseline']);
 assert(independentPrompts.at(-1)!.includes(descriptive));
 assert(independentPrompts.at(-1)!.includes('提前切走会丢失刷头离开后的鼻侧色痕。'));
 assert.match(independentPrompts.at(-1)!,/baseline_criterion/);
 const returned=(narrationReject.artifact.narration_repair_findings as Array<{baseline_criterion?:{field:string;quote:string}}>)[0];
 assert.deepEqual(returned.baseline_criterion,{field:'connection',quote:description.clipMentorAnalysis!.source_breakdown!.points[0].teaching_basis!.connection});
 for(const [invalid,expected] of [
  ['missing-criterion','teaching_final_narration_baseline_criterion_invalid'],
  ['new-criterion','teaching_final_narration_baseline_criterion_invalid'],
  ['partial-criterion','teaching_final_narration_baseline_criterion_invalid'],
  ['no-claim-quote','teaching_final_narration_receipt_invalid'],
  ['bare-unit','teaching_final_narration_unit_finding_unbound'],
 ] as const){
  narrationAction=invalid;calls=[];
  const failed=await taskFor('teaching-final-narration-'+invalid,description,3,'exemplar-v1');
  failed.stage='copy_review';
  await advanceProductionTask(failed,productionStageWorker,productionTaskStore);
  assert.equal(failed.status,'blocked');
  assert.equal(failed.error,'Error: '+expected);
  assert.equal(failed.repairs,0,'invalid review cannot dispatch a new author repair');
  assert.deepEqual(calls,['baseline']);
 }
 narrationAction=undefined;
 const legacyRepair=await taskFor('teaching-final-narration-legacy-dispatch',description,3,'exemplar-v1');
 legacyRepair.stage='blueprint';
 const priorFinding=structuredClone(narrationReject.artifact.narration_repair_findings as Array<Record<string,unknown>>);
 delete priorFinding[0].baseline_criterion;
 legacyRepair.repairContext={...narrationReject.artifact,narration_repair_findings:priorFinding};
 await productionTaskStore.save(legacyRepair);
 const resumedLegacyRepair=await productionTaskStore.load(legacyRepair.projectId,legacyRepair.taskId);
 calls=[];
 await advanceProductionTask(resumedLegacyRepair,productionStageWorker,productionTaskStore);
 assert.equal(resumedLegacyRepair.status,'blocked');
 assert.match(resumedLegacyRepair.error??'',/teaching_final_narration_baseline_criterion_missing_in_saved_review/);
 assert.deepEqual(calls,[],'a stored unbound review cannot authorize any dispatch after upgrade');
 const staleRepair=await taskFor('teaching-final-narration-reselected-point',description,3,'exemplar-v1');
 staleRepair.stage='blueprint';
 const staleFinding=structuredClone(narrationReject.artifact.narration_repair_findings as Array<{baseline_criterion:{quote:string}}>);
 staleFinding[0].baseline_criterion.quote='旧选题里已经被替换的判断要求。';
 staleRepair.repairContext={...narrationReject.artifact,narration_repair_findings:staleFinding};
 await assert.rejects(productionStageWorker(staleRepair,runNarration('fixture-narration-stale-dispatch')),
  /teaching_final_narration_baseline_criterion_stale_in_saved_review/);
 assert.deepEqual(calls,[],'a changed criterion cannot dispatch with an obsolete repair');
 staleRepair.stage='analysis';
 delete staleRepair.completed.analysis;
 await advanceProductionTask(staleRepair,async current=>{
  if(current.stage==='analysis')return {artifact:{revision:current.projectRevision}};
  assert.equal(current.stage,'blueprint');
  assert.equal(current.repairContext?.narration_repair_findings,undefined,'a completed reselection retires obsolete narration authority');
  throw Error('fixture stops before new author dispatch');
 },productionTaskStore);
 assert.match(staleRepair.error??'',/fixture stops before new author dispatch/);
 const paletteCopy=narrationCounterexample.items[0].narration_ms;
 const paletteTask=await taskFor('teaching-final-narration-palette-description',narrationDoc(paletteCopy,true),0,'exemplar-v1');
 paletteTask.stage='copy_review';
 const paletteRejection=await productionStageWorker(paletteTask,runNarration('fixture-narration-palette-no'));
 assert.equal(paletteRejection.repair,'blueprint');
 assert.match(String(paletteRejection.artifact.teaching_baseline_issue),/缺少分开拍/);
 assert(independentPrompts.at(-1)!.includes(paletteCopy));
 badNarrationTask.repairContext=narrationReject.artifact;
 const narrationRepair=await productionAuthorTaskData({...badNarrationTask,stage:'blueprint',repairContext:{
  ...narrationReject.artifact,repair:{prior:[]},
 }},description,{policy:null,references:[]});
 assert.deepEqual(narrationRepair.narrationRepair?.findings,narrationReject.artifact.narration_repair_findings,
  'author sees group-specific narration findings even with an older copy-review repair attached');
 assert.match(narrationRepair.narrationRepair!.instruction,/保留已核选题/);
 calls=[];
 await assert.rejects(productionStageWorker(badNarrationTask,runNarration('fixture-narration-repeat')),/teaching_final_narration_repair_no_progress/);
 assert.deepEqual(calls,[]);
 const unsupportedApplication='Dia dah sapu bedak di bawah mata.';
 const twoLineDraft=narrationDoc(unsupportedApplication);
 const twoLineInternal=(twoLineDraft.clipMentorAnalysis!.blueprint[0] as {internal_review:Record<string,any>}).internal_review;
 const currentCandidate=twoLineInternal[twoLineInternal.current_script_candidate];
 currentCandidate.lines.push({...currentCandidate.lines[0],id:'fixture-sibling',narration_ms:'Pada bahagian ini.',caption_lines:['Pada bahagian ini.']});
 const citedTask=await taskFor('teaching-final-narration-cited-line',twoLineDraft,3,'exemplar-v1');
 citedTask.stage='copy_review';
 const adviceText='仅用于核对作者入口的选材建议';
 citedTask.input.doneCriteria=[{kind:'source_teaching',source:{assetId:citedTask.input.sourceAssetId,sha256:sourceHash},
  quote:'保留画面所能支持的讲解',guidance:[{category:'temporarily_unused',text:adviceText,
   source:{who:'fixture author',reference:'fixture selection discussion'},
   rationale:'先对照另一段有证据的动作。',reconsiderWhen:'用法组调整时重新看。'}],
  closing:{status:'weak_candidate',note:'已登记待核线索',evidenceRange:[3.5,4.5]}}];
 narrationAction='cited-fact';
 const citedRepair=await productionStageWorker(citedTask,runNarration('fixture-narration-cited-line'));
 assert.equal(citedRepair.repair,'blueprint');
 assert(!independentPrompts.at(-1)!.includes(adviceText),'author suggestions cannot influence the independent verdict as review requirements');
 const unsupportedFinding=(citedRepair.artifact.narration_repair_findings as Array<{quote:string;baseline_criterion:{field:string}}>)[0];
 assert.equal(unsupportedFinding.quote,unsupportedApplication);
 assert.equal(unsupportedFinding.baseline_criterion.field,'claim_limit');
 const siblingEdit=structuredClone(twoLineDraft);
 const siblingInternal=(siblingEdit.clipMentorAnalysis!.blueprint[0] as {internal_review:Record<string,any>}).internal_review;
 Object.assign(siblingInternal[siblingInternal.current_script_candidate].lines[1],
  {narration_ms:'Di sini.',caption_lines:['Di sini.']});
 const siblingTask=await taskFor('teaching-final-narration-sibling-only-edit',siblingEdit,3,'exemplar-v1');
 siblingTask.stage='copy_review';
 siblingTask.input.doneCriteria=citedTask.input.doneCriteria;
 siblingTask.repairContext=citedRepair.artifact;
 calls=[];
 await assert.rejects(productionStageWorker(siblingTask,runNarration('fixture-narration-sibling-only-edit')),/teaching_final_narration_repair_no_progress/);
 assert.deepEqual(calls,[],'editing an uncited sibling cannot re-review the same rejected line');
 narrationAction='cited-teaching';
 const missingLesson=await productionStageWorker(citedTask,runNarration('fixture-narration-cited-teaching'));
 siblingTask.repairContext=missingLesson.artifact;
 await assert.rejects(productionStageWorker(siblingTask,{
  signal:new AbortController().signal,
  async effect(){throw Error('the amended teaching point reached review');},
 }),/the amended teaching point reached review/);
 const superficialRewrite=narrationDoc(descriptive+' Ini yang penonton nampak.');
 const repeatedTask=await taskFor('teaching-final-narration-repeat-finding',superficialRewrite,3,'exemplar-v1');
 repeatedTask.stage='copy_review';
 repeatedTask.repairContext=narrationReject.artifact;
 narrationAction='same-finding';
 calls=[];
 await advanceProductionTask(repeatedTask,productionStageWorker,productionTaskStore);
 assert.equal(repeatedTask.status,'blocked');
 assert.match(repeatedTask.error??'',/teaching_final_narration_repair_no_progress: 同一讲解缺口/);
 assert.equal(repeatedTask.repairs,0,'the second identical finding must not dispatch another repair');
 assert.deepEqual(calls,['baseline']);
 const stopped=await productionTaskStore.load(repeatedTask.projectId,repeatedTask.taskId);
 assert.equal(stopped.repairContext?.revision,repeatedTask.projectRevision);
 assert(Object.values(stopped.effects).some(effect=>effect.status==='completed'),'preserve the second independent receipt');
 await advanceProductionTask(stopped,async()=>{throw Error('a paused repair must not restart');},productionTaskStore);
 assert.equal(stopped.sequence,repeatedTask.sequence);
 narrationAction=undefined;
 calls=[];
 badNarrationTask.blueprintFeedback='核对这段是否教会达人决定在哪一刻收镜。';
 badNarrationTask.blueprintFeedbackRevision=badNarrationTask.projectRevision;
 const checkedNewScope=await productionStageWorker(badNarrationTask,runNarration('fixture-narration-new-scope'));
 assert.equal(checkedNewScope.repair,'blueprint');
 assert.deepEqual(calls,['baseline'],'prior rejection of the old brief does not suppress a fresh human question');
 delete badNarrationTask.blueprintFeedback;
 delete badNarrationTask.blueprintFeedbackRevision;
 narrationAction='missing';
 delete badNarrationTask.repairContext;
 await assert.rejects(productionStageWorker(badNarrationTask,runNarration('fixture-narration-missing')),/teaching_final_narration_receipt_invalid/);
 narrationAction='wrong-quote';
 await assert.rejects(productionStageWorker(badNarrationTask,runNarration('fixture-narration-false-quote')),/teaching_final_narration_receipt_invalid/);
 narrationAction='missing-basis';
 await assert.rejects(productionStageWorker(badNarrationTask,runNarration('fixture-narration-missing-basis')),/teaching_final_narration_receipt_invalid/);
 narrationAction=undefined;
 const correctedNarration=narrationDoc(actionable);
 assert.equal(confirmedTeachingDigest(description),confirmedTeachingDigest(correctedNarration));
 const goodNarrationTask=await taskFor('teaching-final-narration-decision',correctedNarration,0,'exemplar-v1');
 goodNarrationTask.stage='copy_review';
 const acceptedNarration=await checkTeachingBaseline(goodNarrationTask,runNarration('fixture-narration-yes'),
  teachingBaselineSource(correctedNarration,goodNarrationTask,[]));
 assert.equal(acceptedNarration.review.feedback_scope,'none');
 assert.doesNotMatch(independentPrompts.at(-1)??'',/feedback_scope|feedback_requires_baseline/,
  'the reviewer must not be asked to classify feedback on a first draft');
 assert.equal(acceptedNarration.review.narration_checks?.[0].status,'ok');
 assert.equal(acceptedNarration.review.narration_checks?.[0].quote,actionable);
 unexpectedInitialFeedbackScope=true;
 const legacyInitial=await checkTeachingBaseline(goodNarrationTask,runNarration('fixture-narration-unexpected-feedback-scope'),
  teachingBaselineSource(correctedNarration,goodNarrationTask,[]));
 assert.equal(legacyInitial.review.feedback_scope,'none','a provider cannot invent a feedback round');
 unexpectedInitialFeedbackScope=false;
 // Both examples from the operator are references for the decision, not approved copy.
 const paletteReference='Dia letak 02 dan 06 sebelah-menyebelah dengan kod masing-masing nampak sekali, jadi penonton tak perlu ingat warna palet tadi untuk membandingkan.';
 const noseReference='Bila berus dialihkan, kamera masih dekat dengan sisi hidung, jadi garis coklat itu nampak jelas tanpa terlindung. Penonton boleh nilai sendiri sejelas mana ia pada muka dia ketika itu.';
 const humanNarration=narrationDoc(paletteReference,true);
 for(const [id,doc,quote] of [['palette',humanNarration,paletteReference],['nose',narrationDoc(noseReference),noseReference]] as const){
  const task=await taskFor('teaching-final-narration-reference-'+id,doc,0,'exemplar-v1');
  task.stage='copy_review';
  const accepted=await checkTeachingBaseline(task,runNarration('fixture-human-narration-yes-'+id),teachingBaselineSource(doc,task,[]));
  assert.equal(accepted.review.narration_checks?.[0].quote,quote);
 }
 const {registerHandoff,readHandoffPolicy,handoffKey}=await import('./handoff');
 let reviewBoardTask:ProductionTask|undefined;
 for(const scenario of ['author-only','generic-review','wrong-revision','wrong-requirements','wrong-purpose','old-feedback','rejected','write-race','requirements-race','pending-author-attachment','pending-without-review','passed','visual-only'] as const){
  const doc=structuredClone(scenario==='rejected'?description:correctedNarration);
  if(scenario==='visual-only'){
   Object.assign(doc.clipMentorAnalysis!.source_breakdown!.units[0].coverage[0],
    {treatment:'visual_only',reason:'用已登记的鼻侧回看承载可见落点。'});
  }
  const task=await taskFor('teaching-publication-'+scenario,doc,0,'exemplar-v1');
  const revision=task.projectRevision!;
  task.stage='copy_review';
  task.completed.blueprint={at:Date.now(),artifact:{revision}};
  const brief={version:1,briefId:'narration-publication',revision:1,mode:'autonomous',phase:'planning',planner:'builtin_agent',executor:'builtin_agent',
   projectId:task.projectId,timelineId:doc.activeTimelineId,objective:'核对口播的拍摄决定',doneCriteria:['引用现行口播。'],blueprint:null,
   budget:{maxModelTurns:6,maxToolCalls:20,maxElapsedMs:120_000,paidToolCalls:{}}};
  const withHandoff=scenario==='passed'||scenario==='requirements-race';
  const requirements=withHandoff?digestValue({objective:brief.objective,doneCriteria:brief.doneCriteria}):panelBlueprintRequirementsDigest(null);
  const raceStore:typeof productionTaskStore={...productionTaskStore,async save(current,guards){
   if(current.status==='awaiting_blueprint'){
    if(scenario==='requirements-race'){
     assert(guards?.some(guard=>guard.key===handoffKey(current.projectId)));
     const policy=await readHandoffPolicy(current.projectId);
     await registerHandoff({projectId:current.projectId,expectedProjectRevision:revision,previousDigest:policy?.digest,
      brief:{...brief,revision:2,objective:'改为核对亲自展示试色的价值'}});
    }else{
     assert(guards?.some(guard=>guard.key==='project:'+current.projectId));
     const concurrent=structuredClone(doc);
     concurrent.clipMentorAnalysis!.revision++;
     await setStoredEntry('project:'+current.projectId,concurrent);
    }
   }
   return productionTaskStore.save(current,guards);
  }};
  await advanceProductionTask(task,async(current,ctx)=>{
   assert.equal(current.stage,'copy_review');
   if(scenario==='generic-review')return {artifact:{revision,authorSelfCheck:'passed',gate:{allowed:true},panelDeliveryVerified:true}};
   const saved=(await loadOfflineStoredProject(current.projectId))!.doc;
   const source=teachingBaselineSource(scenario==='wrong-revision'?humanNarration:saved,current,[]);
   if(scenario==='wrong-purpose')source.purpose={...teachingPurpose,review_question:'旧版审核只问讲解是否清晰。'};
   const reviewRequirements=scenario==='wrong-requirements'?'e'.repeat(64):requirements;
   const digest=scenario==='author-only'||scenario==='pending-without-review'?'a'.repeat(64):(await checkTeachingBaseline(current,ctx,source,reviewRequirements)).digest;
   if(scenario==='old-feedback')current.blueprintFeedback='再核同框的比较依据。';
   // Publish a completed production effect against an explicit handoff. The
   // separate handoff run-admission path is covered by the handoff suites.
   if(withHandoff)await registerHandoff({projectId:current.projectId,expectedProjectRevision:revision,previousDigest:null,brief});
   const pending=scenario==='pending-author-attachment'||scenario==='pending-without-review';
   return {artifact:{revision,requirementsDigest:requirements,authorSelfCheck:pending?'pending':'passed',
    ...(pending?{authorSelfCheckReferenceIssues:[{field:'S5.reference_ids[0]',material:'current_author_check_source'}]}:{}),
    author_self_check_source_digest:'d'.repeat(64),teaching_baseline_digest:digest,
    independentNarrationAnswers:[{status:'ok',decision:'Ignored worker claim',quote:actionable}]},awaitBlueprintFeedback:true};
  },scenario.endsWith('-race')?raceStore:productionTaskStore);
  if(scenario!=='passed'&&scenario!=='visual-only'&&scenario!=='pending-author-attachment'){
   assert.equal(task.status,'blocked');
   assert.match(task.error??'',scenario==='generic-review'?/human_blueprint_draft_binding_missing/
    :scenario.endsWith('-race')?/agent_runtime_precondition_changed/:/human_blueprint_narration_(?:receipt_missing|not_passed)/);
   assert.equal((await productionTaskStore.load(task.projectId,task.taskId)).status,'blocked');
   continue;
  }
  assert.equal(task.status,'awaiting_blueprint',task.error);
  const current=await productionTaskStore.load(task.projectId,task.taskId);
  const published=current.completed.blueprint!.artifact;
  assert.equal(published.teachingDecisionChange,'首份送审蓝图。');
  if(scenario==='visual-only'){
   assert.deepEqual(published.independentNarrationAnswers,[]);
   continue;
  }
  assert.equal((published.independentNarrationAnswers as Array<{quote:string}>)[0].quote,actionable);
  reviewBoardTask=task;
 }
 console.log('PASS saved descriptive narration is returned without reopening the baseline; unchanged, missing and falsely quoted decisions are blocked; actionable narration passes the independent contract');
 const boardStages=new Map<string,string[]>();
 const app=createMiniConnect(error=>{throw error;});
 panelRequest=(req,res)=>app.handle(req,res);
 (clipMentorProductionPlugin(async(t,ctx)=>{
  const stages=boardStages.get(t.taskId);
  if(!stages)throw Error('unexpected fixture task dispatch');
  stages.push(t.stage);
  if(t.stage==='analysis')throw Error('fixture stops after routing back to analysis');
  return productionStageWorker(t,ctx);
 }).configureServer as any)({httpServer:host,config:{server:{}},middlewares:{use:(route:string,fn:any)=>app.use(route,fn)}});
 assert(reviewBoardTask);
 {
  const task=reviewBoardTask,projectId=task.projectId,revision=task.projectRevision!;
  const url=origin+'/api/clipmentor/production-task';
  const headers={Origin:origin,'Sec-Fetch-Site':'same-origin'};
  const panel=await realFetch(url+'?'+new URLSearchParams({view:'panel',projectId}),{headers});
  assert.equal(panel.status,200);
  const {task:{boardIdentity,blueprintRevision}}=await panel.json();
  assert.equal(blueprintRevision,revision);
  const board=await realFetch(url+'?'+new URLSearchParams({view:'panel_board',projectId,revision,boardIdentity}),{headers});
  const html=await board.text();
  assert.equal(board.status,200,board.ok?'':html);
  assert.equal(board.headers.get('x-clipmentor-board-identity'),boardIdentity);
  assert(!html.includes(teachingPurpose.review_question),'the internal review question stays out of the human board');
  assert.match(html,/<section class="group"[^>]*data-unit-id="fixture-group"/u);
  assert(!/独立口播审核|data-quote-line-id|达人把刷头退开后的结果留在镜头中/u.test(html),'independent review is stored without exposing its receipt on the business board');
  assert(html.includes(actionable));
  assert(!html.includes('Ignored worker claim'));
  const published=task.completed.blueprint!.artifact;
  const {openHeadlessEditor}=await import('./headless-editor');
  const editor=await openHeadlessEditor({projectId,runId:task.taskId,origin});
  try{
   const file='references/teaching-purpose.json';
   const loaded=await editor.loadSkill('clipmentor',file);
   assert.deepEqual(JSON.parse(loaded),teachingPurpose);
  }finally{await editor.close();}
  await queueDraftBlueprintFeedback(task,revision,'保留选题，只调整字幕字号。',productionTaskStore);
  assert.equal(task.previousBlueprintTeaching?.selection,published.teachingSelectionDigest);
  assert.equal(task.previousBlueprintTeaching?.narration,published.teachingNarrationDigest);
  const stale=await realFetch(url+'?'+new URLSearchParams({view:'panel_board',projectId,revision,boardIdentity}),{headers});
  assert.equal(stale.status,409,'the board URL cannot expose an earlier receipt after feedback');
  assert(!(await stale.text()).includes(actionable));
  console.log('PASS live panel HTTP binds the independent answers and evidence to the current board revision');
 }
 const qualificationRoutes:Record<string,{calls:string[];stages:string[]}>={};
 for(const scenario of [
  {id:'direction',feedback:'第1组教学方向是错的。'},
  {id:'caption',feedback:'不是说，教学方向错了，只把字幕字号调大。',reviewed:true},
  {id:'action-only',repeat:true},
  {id:'action-only-receipt',receipt:'repeat'},
  {id:'action-paraphrase',receipt:'reject-paraphrase'},
  {id:'spoken-claim'},
 ] as const){
  const feedback='feedback' in scenario?scenario.feedback:undefined;
  const doc=structuredClone(feedback?boardDoc:firstCopyDoc);
  if('repeat' in scenario||scenario.id==='action-paraphrase'){
   const basis=doc.clipMentorAnalysis!.source_breakdown!.points[0].teaching_basis!;
   basis.method='保留刷头和落点的近景';
   basis.connection=scenario.id==='action-paraphrase'?'镜头先给脸颊，再拍刷头伸到鼻子旁边。':visible.text;
  }
  if(scenario.id==='spoken-claim'){
   const analysis=doc.clipMentorAnalysis!;
   const spoken='原片优惠一共到手三支。';
   Object.assign(analysis.evidence[0],{kind:'original_claim',text:spoken});
   const baseline=analysis.source_breakdown!;
   baseline.segments[0].visible_evidence_ids=[];
   baseline.segments[0].claim_evidence_ids=[visible.evidence_id];
   Object.assign(baseline.points[0],{buying_concern:'促单时能拿到几支',teaching_question:'为什么片尾同时摆出三支唇釉？'});
   Object.assign(baseline.points[0].teaching_basis,{selling_point:'买一送二的件数优惠',method:'摆出三支并读出优惠',connection:spoken});
  }
  const task=await taskFor('teaching-qualification-'+scenario.id,doc,2,'exemplar-v1');
  reviewAction='receipt' in scenario?scenario.receipt:undefined;
  const stages:string[]=[];
  calls=[];
  if(feedback){
   const reviewed='reviewed' in scenario;
   const revision=task.projectRevision!;
   const artifact={revision,authorSelfCheck:'passed',author_self_check_source_digest:'c'.repeat(64),
    teaching_baseline_digest:'d'.repeat(64),requirementsDigest:panelBlueprintRequirementsDigest(null),gate:{allowed:true}};
   task.completed.blueprint={at:Date.now(),artifact};
   if(reviewed)task.completed.copy_review={at:Date.now(),artifact};
   task.status='awaiting_blueprint';task.stage='copy_review';
   await productionTaskStore.save(task);
   boardStages.set(task.taskId,stages);
   const url=origin+'/api/clipmentor/production-task';
   const headers={Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'};
   const query=new URLSearchParams({view:'panel',projectId:task.projectId});
   const state=await realFetch(url+'?'+query,{headers});
   assert.equal(state.status,200);
   const {task:{boardIdentity,blueprintRevision}}=await state.json();
   assert.equal(blueprintRevision,revision);
   const boardQuery=new URLSearchParams({view:'panel_board',projectId:task.projectId,revision,boardIdentity});
   const board=await realFetch(url+'?'+boardQuery,{headers});
   const boardHtml=await board.text();
   assert.equal(board.status,200,board.ok?'':boardHtml);
   assert.match(boardHtml,/data-card="group-1"/);
   assert(!boardHtml.includes('data-narration-review'),'a historical board without a matching independent answer may not show one');
   const submit=()=>realFetch(url+'?'+query,{method:'POST',headers,
    body:JSON.stringify({action:'revise_blueprint',revision,boardIdentity,text:feedback,feedbackTarget:reviewed?{scope:'whole',confirmed:true}:{scope:'group',unitId:'fixture-group'}})});
   const results=await Promise.all([submit(),submit()]);
   assert.deepEqual(results.map(response=>response.status).sort(),[200,409],await results[0].clone().text());
   await Promise.all(results.map(response=>response.arrayBuffer()));
   let current=await productionTaskStore.load(task.projectId,task.taskId);
   const deadline=Date.now()+10_000;
   while(current.status!=='blocked'&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,10));
    current=await productionTaskStore.load(task.projectId,task.taskId);
   }
   assert.equal(current.status,'blocked');
   assert.equal(current.blueprintFeedback,feedback);
   assert.equal(current.blueprintFeedbackRevision,revision);
   assert.deepEqual(current.blueprintFeedbackUnitIds,reviewed?undefined:['fixture-group']);
   assert.equal(current.blueprintFeedbackRepair,1,'only one browser request may publish a user repair');
   assert.equal(current.repairs,reviewed?1:2);
   assert.equal(current.completed.copy_review,undefined);
   if(!reviewed){
    const freshDoc=structuredClone(doc);
    // A neutral asset update creates a new project revision after the feedback was accepted.
    freshDoc.assets[0].name='Updated source display name';
    const restarted={...current,projectRevision:revisionOf(freshDoc)};
    assert.notEqual(restarted.projectRevision,revision);
    assert.equal(teachingBaselineDigest(teachingBaselineSource(freshDoc,restarted,[])),
     teachingBaselineDigest(teachingBaselineSource(doc,current,[])),
     'the saved group binding stays part of the same qualification identity after reopening');
   }
  }else await advanceProductionTask(task,async(t,ctx)=>{
    stages.push(t.stage);
    if(t.stage==='analysis')throw Error('fixture stops after the baseline repair is routed');
    return productionStageWorker(t,ctx);
   });
  reviewAction=undefined;
  qualificationRoutes[scenario.id]={calls,stages};
  const after=(await loadOfflineStoredProject(task.projectId))!;
  assert.equal(confirmedTeachingDigest(after.doc),confirmedTeachingDigest(doc));
  assert.equal(teachingDraftPointersDigest(after.doc),teachingDraftPointersDigest(doc));
 }
 assert.deepEqual(qualificationRoutes,{
  direction:{calls:['baseline'],stages:['blueprint','analysis']},
  caption:{calls:['baseline','author'],stages:['blueprint']},
  'action-only':{calls:[],stages:['blueprint','analysis']},
  'action-only-receipt':{calls:['baseline'],stages:['blueprint','analysis']},
  'action-paraphrase':{calls:['baseline'],stages:['blueprint','analysis']},
  'spoken-claim':{calls:['baseline','author'],stages:['blueprint']},
 });
 console.log('PASS teaching direction rewinds, caption feedback reaches author, and action-only baseline or reviewer answer cannot reach writing');
 calls=[];
 const draft=structuredClone(old);
 for(const unit of draft.clipMentorAnalysis!.blueprint)delete (unit as any).internal_review;
 assert.equal(checkSourceBreakdown(draft).status,'structurally_ready','actual revision-9 teaching baseline passed the old pre-copy structural gate');
 const negative=await taskFor('teaching-old',draft);
 await advanceProductionTask(negative,productionStageWorker);
 assert.deepEqual(calls,['baseline'],'an aggregate pass does not hide the groups; no drafting request occurred');
 assert.equal(negative.status,'blocked');
 assert.match(negative.error??'',/U-01/);
 assert.equal(negative.attempts.model,1);
 const cold=await productionTaskStore.load(negative.projectId,negative.taskId);
 await advanceProductionTask(cold,productionStageWorker);
 assert.deepEqual(calls,['baseline'],'cold read reuses the original judgment');
 assert.equal(cold.attempts.model,1);
 assert.equal((await loadOfflineStoredProject(negative.projectId))?.revision,negative.projectRevision);
 console.log('PASS revision 9 reaches the existing pre-copy structure, is rejected before drafting, and reopens without a second model submission');

 const feedbackTask=await taskFor('teaching-feedback',old,2);
 feedbackTask.status='awaiting_blueprint';feedbackTask.stage='copy_review';await productionTaskStore.save(feedbackTask);
 const feedback='第1组教学方向错了。讲清上脸结果怎么引出产品比较。';
 assert.equal(await queueDraftBlueprintFeedback(feedbackTask,feedbackTask.projectRevision!,feedback,productionTaskStore),'queued');
 const visits:string[]=[];
 await advanceProductionTask(feedbackTask,async(task,ctx)=>{
  visits.push(task.stage);
  if(task.stage==='analysis'){
   assert.equal(task.blueprintFeedback,feedback);
   assert.ok(task.repairContext?.teaching_rebuild);
   return {artifact:{revision:task.projectRevision}};
  }
  return productionStageWorker(task,ctx);
 });
 assert.deepEqual(visits,['blueprint','analysis','blueprint']);
 assert.deepEqual(calls,['baseline','baseline'],'unmodified baseline never buys another judgment or advances to drafting');
 assert.match(feedbackTask.error??'',/U-01/);
 assert.equal(teachingDraftPointersDigest((await loadOfflineStoredProject(feedbackTask.projectId))!.doc),teachingDraftPointersDigest(old));
 console.log('PASS displayed-version feedback routes to analysis; no-progress repair does not spend another check');

 const source=teachingBaselineSource(old,feedbackTask,[],'Teaching objective');
 assert.ok(source.evidence.some(e=>e.id==='VIS-1-1'));
 assert.notEqual(teachingBaselineDigest(source),teachingBaselineDigest(teachingBaselineSource(old,feedbackTask,[],'A different objective')));
 const reply={feedback_scope:'baseline',units:source.units.map(unit=>({unit_id:unit.unit_id,status:'fix',source_role:'source role',
  takeaway:'reusable takeaway',reason:'A supported editorial correction',evidence_ids:[]}))};
 const review=validateTeachingBaselineReview(reply,source);
 assert.throws(()=>validateTeachingBaselineReview({...reply,feedback_scope:['baseline']},source),/review_invalid/);
 const unresolved=teachingRebuild(source,old,validateTeachingBaselineReview({...reply,units:reply.units.map(unit=>({...unit,status:'unresolved'}))},source));
 assert.equal(unchangedRejectedTeaching(source,unresolved).length,3);
 const missing=structuredClone(old);
 missing.clipMentorAnalysis!.evidence.find(e=>e.evidence_id==='VIS-1-1')!.observation_id='missing-observation';
 assert.equal(teachingBaselineSource(missing,feedbackTask,[]).evidence.some(e=>e.id==='VIS-1-1'),false);
 const wrong=structuredClone(old);
 wrong.clipMentorAnalysis!.observations!.find(o=>o.observation_id===wrong.clipMentorAnalysis!.evidence.find(e=>e.evidence_id==='VIS-1-1')!.observation_id)!.source_hash='b'.repeat(64);
 assert.equal(teachingBaselineSource(wrong,feedbackTask,[]).evidence.some(e=>e.id==='VIS-1-1'),false);
 for(const fault of ['drop observation','orphan frame','unbound claim'] as const){
  const broken=structuredClone(old),expected=fault==='unbound claim'?'CL-1':'VIS-1-1';
  const entry=broken.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===expected)!;
  if(fault==='drop observation')delete entry.observation_id;
  if(fault==='orphan frame')entry.supporting_evidence_ids=['ghost-frame'];
  if(fault==='unbound claim')entry.source_ids=['ghost-transcript'];
  assert.equal(teachingBaselineSource(broken,feedbackTask,[]).evidence.some(e=>e.id===expected),false);
 }
 const duplicate=structuredClone(old);
 duplicate.clipMentorAnalysis!.evidence.push({...duplicate.clipMentorAnalysis!.evidence.find(e=>e.evidence_id==='VIS-1-1')!,evidence_id:'copy-of-VIS-1-1'});
 duplicate.clipMentorAnalysis!.transcripts[0].words[0].text+='  ';
 assert.equal(unchangedRejectedTeaching(teachingBaselineSource(duplicate,feedbackTask,[]),unresolved).length,3);
 duplicate.clipMentorAnalysis!.transcripts[0].words[0].text+='Frasa tambahan';
 assert.equal(unchangedRejectedTeaching(teachingBaselineSource(duplicate,feedbackTask,[]),unresolved).length,2);
 const reworked=structuredClone(old);
 const b=reworked.clipMentorAnalysis!.source_breakdown!;
 b.points[0].teaching_question='上脸效果怎样留下一个需要用两盘比较回答的问题？';
 b.points[0].change_reason='原片开场承接';
 b.points[2].teaching_question='怎样让观众判断刚上脸时颜色有多深？';
 const checked=teachingBaselineSource(reworked,feedbackTask,[]);
 const one=teachingRebuild(source,old,{...review,units:review.units.slice(0,1)});
 assert.deepEqual(staleRebuiltTeaching(checked,reworked,one),['U-01','U-02'],'the changed second group is stale, untouched third group remains usable');
 assert.ok(newlyChangedTeaching(source,checked,old));
 const internal=(reworked.clipMentorAnalysis!.blueprint[0] as any).internal_review;
 const candidate=structuredClone(internal[internal.current_script_candidate]);
 const plan=structuredClone(internal[internal.current_picture_plan]);
 const [line,...rest]=candidate.lines;
 const tokens=line.narration_ms.split(' ');
 candidate.lines=[{...line,narration_ms:tokens.slice(0,2).join(' ')},{...line,labels:[],narration_ms:tokens.slice(2).join(' ')},...rest];
 internal.current_script_candidate='script_candidate_split';
 internal.current_picture_plan='picture_plan_split';internal.script_candidate_split=candidate;internal.picture_plan_split=plan;
 assert.deepEqual(staleRebuiltTeaching(checked,reworked,one),['U-01','U-02'],'fresh IDs and repagination cannot discharge a rebuild');
 const beforeVoice=candidate.lines[0].narration_ms;
 candidate.lines[0].labels=['Tona highlight'];
 assert.deepEqual(staleRebuiltTeaching(checked,reworked,one),['U-01','U-02'],'a short label cannot discharge a narration rebuild');
 assert.equal(candidate.lines[0].narration_ms,beforeVoice);
 candidate.lines[0].narration_ms='Dia tunjuk hasil dahulu dan kemudian memperkenalkan kedua-dua palet.';
 assert.deepEqual(staleRebuiltTeaching(checked,reworked,one),['U-02']);
 const legacy=structuredClone(one);
 for(const material of Object.values(legacy.prior))Reflect.deleteProperty(material,'voice');
 assert.deepEqual(staleRebuiltTeaching(checked,reworked,legacy),['U-02'],'cold recovery can use the retained original script');
 candidate.lines[0].narration_ms=beforeVoice;
 assert.deepEqual(staleRebuiltTeaching(checked,reworked,legacy),['U-01','U-02'],'a legacy repair cannot be cleared just by relabeling');
 const renamed=structuredClone(reworked);
 renamed.clipMentorAnalysis!.source_breakdown!.units[0].unit_id='U-09';
 const relabeledUnit=structuredClone(renamed.clipMentorAnalysis!.blueprint[0]);
 relabeledUnit.unit_id='U-09';
 renamed.clipMentorAnalysis!.blueprint.push(relabeledUnit);
 const renamedSource=teachingBaselineSource(renamed,feedbackTask,[]);
 assert.deepEqual(staleRebuiltTeaching(renamedSource,renamed,legacy),['U-09','U-02'],'a replacement unit still inherits the rejected teaching point');
 (relabeledUnit as any).internal_review.script_candidate_split.lines[0].narration_ms='Dia tunjuk hasil dahulu dan kemudian memperkenalkan kedua-dua palet.';
 assert.deepEqual(staleRebuiltTeaching(renamedSource,renamed,legacy),['U-02'],'an actually rewritten replacement unit can proceed');
 const archived=(renamed.clipMentorAnalysis!.blueprint[0] as any).internal_review;
 archived[legacy.prior['U-01'].candidateId as string].lines[0].narration_ms='A different historical script';
 assert.deepEqual(staleRebuiltTeaching(renamedSource,renamed,legacy),['U-09','U-02'],'a changed archive cannot establish the original narration');
 const copied=structuredClone(reworked);
 const copiedReview=(copied.clipMentorAnalysis!.blueprint[0] as any).internal_review;
 const copiedCandidate=copiedReview.script_candidate_split;
 const originalLines=copiedReview[one.prior['U-01'].candidateId as string].lines;
 const [originalLine]=originalLines;
 copiedCandidate.lines=[...originalLines,{...originalLine,narration_ms:'Kemudian, perhatikan warna pada pipi.'}];
 assert.deepEqual(staleRebuiltTeaching(checked,copied,one),['U-01','U-02'],
  'appending another sentence leaves the rejected narration intact');
 const [,splitSecond]=copied.clipMentorAnalysis!.blueprint;
 const splitReview=(splitSecond as any).internal_review;
 const splitScript=splitReview[splitReview.current_script_candidate];
 const [firstWord,...remainingWords]=originalLines.map((line:{narration_ms:string})=>line.narration_ms).join(' ').split(/\s+/u);
 copiedCandidate.lines=[{...originalLine,narration_ms:firstWord}];
 splitReview.current_script_candidate='script_candidate_rebuilt';
 splitReview.current_picture_plan='picture_plan_rebuilt';
 splitReview.script_candidate_rebuilt={...splitScript,lines:[{...originalLine,narration_ms:remainingWords.join(' ')}]};
 splitReview.picture_plan_rebuilt={};
 const splitSource=structuredClone(checked);
 splitSource.units[1].points.push(splitSource.units[0].points.shift()!);
 assert.deepEqual(staleRebuiltTeaching(splitSource,copied,one),['U-01','U-02'],
  'splitting the unchanged narration across units retaining its teaching point does not clear the rebuild');
 const merged=structuredClone(old);
 const mb=merged.clipMentorAnalysis!.source_breakdown!,[first,second]=mb.units;
 first.original_segment_ids.push(...second.original_segment_ids);
 first.explanation_segment_ids.push(...second.explanation_segment_ids);
 first.original_source_ranges=[[0,45.28]];first.coverage.push(...second.coverage);first.revisits.push(...second.revisits);
 mb.units.splice(1,1);
 assert.equal(copyPreparationReady(merged),false);
 const historical=retireTeachingDrafts(merged);
 assert.equal(copyPreparationReady(historical),true);
 const past=(historical.clipMentorAnalysis!.blueprint[1] as any).internal_review;
 assert.equal(past.current_script_candidate,undefined);
 assert.ok(Object.keys(past).some(k=>k.startsWith('script_candidate_')));
 console.log('PASS provenance, literal verdict, evidence dead end, adjacent stale copy, pagination, and merge history');

 const pending=await taskFor('teaching-checkpoint',old);
 pending.stage='analysis';pending.repairs=1;
 const before=(await loadOfflineStoredProject(pending.projectId))!;
 const restored=structuredClone(before.doc);
 restored.clipMentorAnalysis!.source_breakdown!.points[0].teaching_question=b.points[0].teaching_question;
 restored.clipMentorAnalysis!.revision++;
 const stagedRevision=revisionOf(restored);
 pending.teachingAnalysisPublication={baseRevision:before.revision,revision:stagedRevision,repairEpoch:pending.repairs,
  inputDigest:digestValue({brief:pending.input.brief,feedback:undefined,feedbackRevision:undefined,policy:panelBlueprintRequirementsDigest(null)}),
  outputDigest:digestValue(restored),analysis:restored.clipMentorAnalysis!,artifact:{revision:stagedRevision}};
 await productionTaskStore.save(pending);
 const noRequests={signal:new AbortController().signal,async effect(){throw Error('recovery must not submit');}};
 const restart=()=>productionTaskStore.load(pending.projectId,pending.taskId);
 for(const phase of ['before commit','after commit']){
  const current=await restart();
  assert.equal((await productionStageWorker(current,noRequests)).artifact.revision,stagedRevision,phase);
  assert.equal((await loadOfflineStoredProject(pending.projectId))?.revision,stagedRevision,phase);
 }
 const changedProject=structuredClone(restored);changedProject.clipMentorAnalysis!.product.category='unrelated editor write';
 await setStoredEntry('project:'+pending.projectId,changedProject);
 await assert.rejects(productionStageWorker(await restart(),noRequests),/production_teaching_analysis_publication_unconfirmed/);
 console.log('PASS both sides of the analysis commit boundary recover exactly, and unrelated writes cannot be adopted');

 analysisCorrection=structuredClone(b);
 for(const [i,question] of [[2,'怎样让观众判断颜色刚上脸时有多深？'],[3,'如何用两盘同框与转脸展示让买家分清盘色和上脸亮度？']] as const){
  analysisCorrection.points[i].teaching_question=question;analysisCorrection.points[i].change_reason='根据原片可回读的实际拍法纠正选题';
 }
 const correctionTask=await taskFor('teaching-actual-analysis',old,3);
 correctionTask.status='awaiting_blueprint';correctionTask.stage='copy_review';await productionTaskStore.save(correctionTask);
 await queueDraftBlueprintFeedback(correctionTask,correctionTask.projectRevision!,feedback,productionTaskStore);
 calls=[];await advanceProductionTask(correctionTask,productionStageWorker);
 const realCorrection=(await loadOfflineStoredProject(correctionTask.projectId))!.doc;
 assert.deepEqual(calls,['baseline','analysis','analysis','baseline','author']);
 assert.equal(realCorrection.clipMentorAnalysis!.source_breakdown!.points[0].teaching_question,b.points[0].teaching_question);
 assert.equal(teachingDraftPointersDigest(realCorrection),teachingDraftPointersDigest(old),'analysis rewrite leaves old candidates for the draft phase');
 assert.equal(correctionTask.teachingAnalysisPublication,undefined,'analysis publication body is cleared once its stage settles');
 for(const [size,complete,duplicateConcern] of [['small',true,false],['archived',true,true],['archived',false,false]] as const){
  rejectSupplement=size;
  supplementArchiveId=undefined;
  const item=await taskFor('teaching-supplement-'+size+'-'+complete,firstCopyDoc,0,'exemplar-v1');
  item.stage='analysis';delete item.completed.analysis;
  analysisCorrection=structuredClone(breakdown);
  if(duplicateConcern){
   const point=analysisCorrection.points[0];
   Object.assign(point.teaching_basis!,{buying_concern:point.buying_concern});
  }
  if(!complete){
   delete analysisCorrection.points[0].teaching_basis;
   analysisCorrection.points[0].change_reason='Fixture registers an incomplete editorial choice';
  }
  const original=(await loadOfflineStoredProject(item.projectId))!;
  const context={signal:new AbortController().signal,effect:async()=>null} as Parameters<typeof productionStageWorker>[1];
  if(complete){
   const result=await productionStageWorker(item,context);
   assert.ok(result.artifact.recoveredAnalysisWrite,'worker cites the two real tool calls');
   const readback=await loadOfflineStoredProject(item.projectId);
   assert.equal(result.artifact.revision,readback?.revision);
   assert(!Object.hasOwn(readback!.doc.clipMentorAnalysis!.source_breakdown!.points[0].teaching_basis!,'buying_concern'));
  }else{
   await assert.rejects(productionStageWorker(item,context),/tool failed/i);
   assert.equal((await loadOfflineStoredProject(item.projectId))?.revision,original.revision);
  }
  if(size==='archived'){
   assert(supplementArchiveId);
   const {loadAgentArtifact}=await import('../../src/persist/agentRuntimeStore');
   const artifact=await loadAgentArtifact(item.projectId,supplementArchiveId);
   assert(artifact);
   const issues=JSON.parse(artifact.body).evidence_issues;
   assert.equal(issues.length,100);
   assert.equal(issues.at(-1).evidence_id,'image-row-99');
  }
 }
 console.log('PASS failed supplementary write publishes only a complete registered analysis for independent review');
 rejectSupplement=false;
 analysisCorrection=undefined;
 console.log('PASS real worker executes the analysis tool and checks the corrected source before authoring can resume');

 const corrected=structuredClone(draft);
 corrected.clipMentorAnalysis!.source_breakdown=b;
 const fixedTask=await taskFor('teaching-corrected',corrected);
 calls=[];await advanceProductionTask(fixedTask,productionStageWorker);
 assert.deepEqual(calls,['baseline','author'],'correcting revision 9 on the same original evidence reaches authoring');
 assert.equal(fixedTask.attempts.model,2);

 const known=structuredClone(accepted.cases[0]!.doc) as unknown as ProjectDoc;
 known.timelines=projectDoc(1080,1920).timelines;known.activeTimelineId=known.timelines[0]!.id;
 const knownTask=await taskFor('teaching-known',known);
 calls=[];await advanceProductionTask(knownTask,productionStageWorker);
 assert.deepEqual(calls,['baseline','author'],'a different valid opening reaches actual author dispatch after pre-draft admission');
 assert.equal(knownTask.attempts.model,2);
 assert.equal(knownTask.attempts.review,0);
 console.log('PASS qualified other-product baseline reaches the separate author slot without starting independent review, voice or render');

 const strictTask=await taskFor('teaching-exemplar-old',draft,0,'exemplar-v1');
 const strictSource=teachingBaselineSource(draft,strictTask,[]);
 const withoutTranslation=structuredClone(draft);
 delete withoutTranslation.clipMentorAnalysis!.evidence.find(e=>e.evidence_id==='CL-3')!.meaning_zh;
 const originalEvidence=teachingBaselineSource(withoutTranslation,strictTask,[]).evidence;
 assert.equal(originalEvidence.find(e=>e.id==='CL-3')?.status,'candidate_unverified_speech');
 assert.equal(originalEvidence.find(e=>e.id==='VIS-4-1')?.kind,'visible_action');
 assert.deepEqual(teachingPointGaps(strictSource,draft).map(gap=>gap.split(' ')[0]),['P-01','P-02','P-03','P-04','P-05']);
 calls=[];await advanceProductionTask(strictTask,productionStageWorker);
 assert.deepEqual(calls,[],'the actual revision-9 missing baseline is refused before spending on review or writing copy');
 assert.match(strictTask.error??'',/P-01.*P-05/);

 const repeated=await taskFor('teaching-repeat-point-gaps',draft,3,'exemplar-v1');
 const noEffect={signal:new AbortController().signal,async effect(){throw Error('Pre-copy point gaps must never invoke a model');}};
 const firstGap=await productionStageWorker(repeated,noEffect);
 assert.equal(firstGap.repair,'analysis');
 repeated.repairContext=firstGap.artifact;
 await assert.rejects(()=>productionStageWorker(repeated,noEffect),/teaching_baseline_repair_no_progress.*P-01/);

 const samples=[...exemplars.green_makes.map(sample=>({...sample,selling_point:sample.buying_concern})),...exemplars.reference_controls];
 const strictPositive:typeof strictSource={...strictSource,feedback:null,rebuilding:false,
  evidence:samples.map(p=>({...p.evidence,range:p.evidence.range as [number,number],kind:'visible_action',status:'agent_observed_candidate'}))};
 strictPositive.units=samples.map((sample,index)=>({
  ...strictSource.units[0],unit_id:'green-'+index,source_ranges:[sample.evidence.range as [number,number]],
  coverage:[{point_id:sample.point_id,treatment:'explain'}],
  points:[{...strictSource.units[0].points[0],point_id:sample.point_id,teaching_question:sample.question,role:'primary',supports_point_id:undefined,
   teaching_basis:{selling_point:sample.selling_point,evidence_ids:[sample.evidence.id],method:sample.evidence.text,
    connection:sample.connection_excerpt,must_capture:sample.evidence.text,claim_limit:'仅以可见演示说明表达方式',exemplar:sample.principle as 'buyer-first',difference:'以这条原片证据说明本次用途'}}],
 }));
 const positiveReceipt={feedback_scope:'none',whole_film:{status:'ok',main_point_id:samples[0].point_id,
  focus:'围绕产品表现帮助观众判断',alternative:'集中讲产品的包装信息',reason:'当前案例的原片演示承担了更直接的购买判断。',
  evidence_id:samples[0].evidence.id,source_quote:samples[0].evidence.text,affected_unit_ids:[] as string[]},
  units:samples.map((p,i)=>({unit_id:'green-'+i,status:'ok',source_role:p.buying_concern,
  takeaway:p.connection_excerpt,evidence_ids:[p.evidence.id],reason:'fixture replay',
  point_checks:[{point_id:p.point_id,status:'ok',learner_takeaway:p.connection_excerpt,connection:p.connection_excerpt,
   question_quote:p.question,source_evidence_id:p.evidence.id,source_quote:p.evidence.text}]}))};
 assert(validateTeachingBaselineReview(positiveReceipt,strictPositive).units.every(u=>u.status==='ok'));
 const {source_quote:_,...selectedWhole}=positiveReceipt.whole_film;
 const selectedReceipt={...positiveReceipt,reference_protocol:'selection-v1',whole_film:selectedWhole,
  units:positiveReceipt.units.map(unit=>({...unit,point_checks:unit.point_checks.map(
   ({source_quote,question_quote,...point})=>point)}))};
 assert.deepEqual(validateTeachingBaselineReview(selectedReceipt,strictPositive),validateTeachingBaselineReview(positiveReceipt,strictPositive));
 const longEvidence=structuredClone(strictPositive);
 longEvidence.evidence[0].text+=' This sentence adds more visible detail to the same evidence. '.repeat(10);
 const longSelection=validateTeachingBaselineReview(selectedReceipt,longEvidence);
 assert.equal(longSelection.whole_film?.source_quote,longEvidence.evidence[0].text);
 assert.deepEqual(validateTeachingBaselineReview(JSON.parse(JSON.stringify(longSelection)),longEvidence),longSelection);
 assert.equal(validateTeachingBaselineReview(positiveReceipt,longEvidence).whole_film?.status,'ok');
 const unrelatedSameWindow={...strictPositive.evidence[0],id:'same-window-without-selection'};
 const selectedWrongPoint=structuredClone(selectedReceipt);
 selectedWrongPoint.units[0].point_checks[0].source_evidence_id=unrelatedSameWindow.id;
 assert.throws(()=>validateTeachingBaselineReview(selectedWrongPoint,{...strictPositive,
  evidence:[...strictPositive.evidence,unrelatedSameWindow]}),/evidence_selected_for_this_point/);
 const {wholeFilmIssue}=await import('./production-teaching-baseline');
 // Same known-good fixture, with the exact groups now explicitly approved.
 {
  const approved=strictPositive.units.map(unit=>({id:unit.unit_id,decision:'Preserve the confirmed demonstration.',
   points:unit.points.map(point=>({id:point.point_id,question:point.teaching_question,treatment:'explain',
    boundary:point.teaching_basis?.claim_limit}))}));
  const scoped={...strictPositive,confirmedGroups:approved};
  const main=selectedReceipt.whole_film.main_point_id;
  const unit=scoped.units.find(unit=>unit.points.some(point=>point.point_id===main))!;
  const formal={...selectedReceipt.whole_film,status:'fix',affected_unit_ids:[unit.unit_id]};
  const suggestion={...selectedReceipt,whole_film:{...formal,finding_kind:'new_topic'}};
  const read=validateTeachingBaselineReview(suggestion,scoped);
  assert.equal(read.whole_film?.status,'fix','the original verdict stays in the receipt');
  assert.equal(wholeFilmIssue(read.whole_film),undefined,'a different teaching topic is not a repair');
  assert.equal(teachingRebuild(scoped,old,read).wholeFilm,undefined);
  assert.deepEqual(validateTeachingBaselineReview(read,scoped),read);
  assert.throws(()=>validateTeachingBaselineReview({...selectedReceipt,whole_film:formal},scoped),/confirmed_criterion_invalid/);
  const anchor={unit_id:unit.unit_id,point_id:main,field:'claim_limit',evidence_id:formal.evidence_id};
  const factual={...selectedReceipt,whole_film:{...formal,finding_kind:'confirmed_gap',baseline_criteria:[anchor],
   reason:'The approved boundary does not allow saying the color was already applied.'}};
  const factualRead=validateTeachingBaselineReview(factual,scoped);
  assert.match(wholeFilmIssue(factualRead.whole_film)??'',/already applied/);
  assert.deepEqual(teachingRebuild(scoped,old,factualRead).wholeFilm?.unitIds,[unit.unit_id]);
  for(const changed of [{...anchor,unit_id:'other-group'},{...anchor,point_id:'other-point'},{...anchor,evidence_id:'wrong-evidence'}])
   assert.throws(()=>validateTeachingBaselineReview({...factual,whole_film:{...factual.whole_film,baseline_criteria:[changed]}},scoped),/confirmed_criterion_invalid/);
  assert.throws(()=>validateTeachingBaselineReview({...factual,whole_film:{...factual.whole_film,evidence_id:'wrong-evidence'}},scoped),/original_source_evidence/);
 }
 const requiredDecision={category:'teaching_decision' as const,text:'Retain the confirmed demonstration decision.',
  source:{who:'editor',reference:'confirmed fixture'},rationale:'Retain its teaching role.',reconsiderWhen:'Editor revises the plan.',
  confirmedDecisionId:'fixture-demonstration'};
 const scopedDecision={...strictPositive,confirmedDecisions:[requiredDecision]};
 assert.throws(()=>validateTeachingBaselineReview(selectedReceipt,scopedDecision),/confirmed_teaching_checks_missing/);
 const missingDecision={id:requiredDecision.confirmedDecisionId,status:'missing',reason:'The editor-confirmed decision is not in the draft.'};
 for(const status of ['ok','unresolved'] as const){
  const inputWhole=status==='ok'?selectedReceipt.whole_film:{...selectedReceipt.whole_film,status,
   evidence_id:null,affected_unit_ids:['green-0']};
  const missing=validateTeachingBaselineReview({...selectedReceipt,whole_film:inputWhole,
   confirmed_teaching_checks:[missingDecision]},scopedDecision);
  assert.equal(missing.whole_film?.status,status,'keep the independent whole-film answer intact');
  assert.deepEqual(validateTeachingBaselineReview(JSON.parse(JSON.stringify(missing)),scopedDecision),missing);
  assert.match(teachingRebuild(scopedDecision,old,missing).wholeFilm?.reason??'',/editor-confirmed decision/);
 }
 {
  const {createAgentRun}=await import('../../src/persist/agentRuntimeStore');
  const {runtimeEvent}=await import('../agent-runs/store-values');
  const raw=structuredClone({...selectedReceipt,confirmed_teaching_checks:[missingDecision],whole_film:{...selectedReceipt.whole_film,
   status:'unresolved',evidence_id:null,affected_unit_ids:['green-0']}});
  Object.assign(raw.units[0].point_checks[0],{status:'unresolved',source_evidence_id:null});
  const valid=validateTeachingBaselineReview(raw,scopedDecision);
  const malformed={...valid,whole_film:{...valid.whole_film,status:'fix',reason:`${missingDecision.id} ${missingDecision.reason}`}};
  const digest=teachingBaselineDigest(scopedDecision),operationId='fixture-projected-whole-film';
  const key='blueprint:initial:0:teaching-baseline:'+digest;
  const replayTask={...strictTask,projectId:'fixture-projected-whole-film-project',effects:{[key]:{
   kind:'model' as const,status:'completed' as const,operationId,result:{digest,runId:operationId,review:malformed},
  }}};
  const archived=structuredClone(replayTask.effects);
  const noProvider={signal:new AbortController().signal,async effect(){throw Error('The archived operation cannot dispatch');}};
  await assert.rejects(checkTeachingBaseline(replayTask,noProvider,scopedDecision),/recovery_run_unverified/);
  const createdAt=replayTask.createdAt+1;
  const events=[runtimeEvent({id:1,type:'text-delta',data:{text:JSON.stringify(raw)},at:createdAt}),
   runtimeEvent({id:2,type:'done',data:{status:'completed'},at:createdAt+1})];
  await createAgentRun({version:1,runId:operationId,projectId:replayTask.projectId,status:'completed',askOnly:true,
   userInputPreview:'fixture',userInputDigest:digest,createdAt,updatedAt:createdAt+1,backend:replayTask.input.authorBackend??'api',
   modelId:replayTask.input.author.model,provider:replayTask.input.author.provider,
   context:{transportStatus:'completed'} as any,artifactIds:[],checkpointIds:[],proposalIds:[],
   events:events.map((event,i)=>({...event,eventId:`${operationId}-${i}`,projectId:replayTask.projectId,runId:operationId,sequence:i+1,createdAt:createdAt+i}))});
  assert.deepEqual((await checkTeachingBaseline(replayTask,noProvider,scopedDecision)).review,valid);
  assert.deepEqual(replayTask.effects,archived);
 }
 assert.equal(validateTeachingBaselineReview({...selectedReceipt,confirmed_teaching_checks:[
  {id:requiredDecision.confirmedDecisionId,status:'covered',reason:'Verified against this point.',unit_id:'green-0',
   point_id:samples[0].point_id,evidence_id:samples[0].evidence.id}
 ]},scopedDecision).whole_film?.status,'ok');
 const {verifyFrozenTopics}=await import('./production-frozen-topics.verify-suite');
 await verifyFrozenTopics(draft,strictTask,strictPositive,validateTeachingBaselineReview(positiveReceipt,strictPositive));
 const {verifyTeachingSelections}=await import('./production-teaching-selection.verify-suite');
 const selectionFixtures=verifyTeachingSelections(old,strictTask);
 const selectionWorkerTask=async(label:string,doc:ProjectDoc)=>{
  const task=await taskFor(label,doc,2,'exemplar-v1');
  task.input.panelDelivery!.selectionPolicy='v1';
  task.stage='copy_review';
  await productionTaskStore.save(task);
  return task;
 };
 const missingBrief=await selectionWorkerTask('teaching-first-glance-missing',selectionFixtures.doc);
 missingBrief.input.panelDelivery!.firstGlanceWriting=true;
 missingBrief.stage='blueprint';
 await productionTaskStore.save(missingBrief);
 const briefResult=await productionStageWorker(missingBrief,noEffect);
 assert.equal(briefResult.repair,'analysis');
 assert.match(String(briefResult.artifact.teaching_baseline_issue),/缺一眼效果/);
 assert.equal(missingBrief.attempts.model,0,'missing brief never dispatches the writer');
 const withBrief=structuredClone(selectionFixtures.doc);
 for(const unit of withBrief.clipMentorAnalysis!.source_breakdown!.units)
  unit.teaching_selection!.first_glance='让实物和参照同时入画，观众马上能把两者对上。';
 const authorData=await productionAuthorTaskData(missingBrief,withBrief,{policy:null,references:[]});
 assert(authorData.narrationBrief?.groups.every(group=>group.first_glance));
 assert.match(authorData.narrationBrief!.instruction,/先替换弱句/);
 const missingRole=await selectionWorkerTask('teaching-selection-missing-role',selectionFixtures.missingRole);
 const overrun=await selectionWorkerTask('teaching-selection-overrun',selectionFixtures.reassurance);
 const repaired=await selectionWorkerTask('teaching-selection-recorded',selectionFixtures.doc);
 for(const task of [missingRole,overrun,repaired]){
  await assert.rejects(productionStageWorker(task,{...noEffect,async effect(){throw Error('selection-review-boundary');}}),
   /selection-review-boundary/,'advisory selection and timing notes must reach the existing independent review');
  assert.equal(task.attempts.model,0);
 }
 wholeFilmAction='selection-omission';
 calls=[];
 await advanceProductionTask(missingRole,async(task,stage)=>{
  if(task.stage!=='copy_review')throw Error('selection fixture stops before reselection');
  const result=await productionStageWorker(task,stage);
  assert.equal(result.repair,'analysis');
  assert.match(String(result.artifact.teaching_baseline_issue),/原片另有买家需要的结果/);
  assert.equal((result.artifact.teaching_rebuild as {wholeFilm:{evidenceId:string}}).wholeFilm.evidenceId,'V-hook');
  return result;
 });
 wholeFilmAction=undefined;
 assert.deepEqual(calls,['baseline']);
 assert.equal(missingRole.completed.copy_review,undefined);
 const inference=await selectionWorkerTask('teaching-selection-inference',selectionFixtures.inference);
 calls=[];
 await advanceProductionTask(inference,async(task,stage)=>{
  if(task.stage!=='copy_review')throw Error('selection fixture stops before redrafting');
  const result=await productionStageWorker(task,stage);
  assert.equal(result.repair,'blueprint');
  assert.match(String(result.artifact.teaching_baseline_issue),/剪辑动机/);
  return result;
 });
 assert.deepEqual(calls,['baseline']);
 assert.match(independentPrompts.at(-1)??'',/把推断的动机/);
 assert.match(independentPrompts.at(-1)??'',/unselectedBuyerRoles/);
 assert.equal(inference.completed.copy_review,undefined);
 console.log('PASS selection and timing advice reach the existing review without forcing a repair, and substantive narration failures still route to blueprint');
 // Replay the blind local decisions. Semantic judgment is supplied by the
 // reviewer; the product checks that each verdict is complete and source-bound.
 for(const sample of humanTeachingCalibration){
  const [start,end]=sample.sourceSeconds;
  const range:[number,number]=[start,end];
  const evidence={...strictPositive.evidence[0],id:sample.id,range,text:sample.source};
  const [unit]=structuredClone(strictPositive.units);
  const [point]=unit.points;
  unit.source_ranges=[range];
  point.buying_concern=sample.buyer;
  point.teaching_question=sample.question;
  point.teaching_basis!.evidence_ids=[evidence.id];
  point.teaching_basis!.method=sample.source;
  point.teaching_basis!.selling_point=sample.sellingPoint;
  const source={...strictPositive,units:[unit],evidence:[evidence]};
  const [decision]=structuredClone(positiveReceipt.units);
  decision.evidence_ids=[evidence.id];
  const [check]=decision.point_checks;
  Object.assign(check,{source_evidence_id:evidence.id,source_quote:sample.source,question_quote:point.teaching_question});
  const wholeFilm={...positiveReceipt.whole_film,evidence_id:evidence.id,source_quote:sample.source};
  for(const [connection,status] of [[sample.useful,'ok'],[sample.actionOnly,'fix'],[sample.overclaim,'fix']] as const){
   point.teaching_basis!.connection=connection;
   Object.assign(check,{connection,status,learner_takeaway:connection});
   const review=validateTeachingBaselineReview({...positiveReceipt,whole_film:wholeFilm,units:[decision]},source);
   assert.equal(review.units[0].status,status,`${sample.id} ${connection}`);
  }
  check.source_quote=humanTeachingCalibration.find(other=>other.id!==sample.id)!.source;
  assert.throws(()=>validateTeachingBaselineReview({...positiveReceipt,whole_film:wholeFilm,units:[decision]},source),/point_source_quote_invalid/);
 }
 console.log('PASS paired position-blind calibration verdicts remain bound to the current product evidence');
 const {whole_film:_omitted,...unitsOnly}=positiveReceipt;
 assert.throws(()=>validateTeachingBaselineReview(unitsOnly,strictPositive),/teaching_whole_film_review_invalid/,
  'passing each submitted topic cannot replace the whole-film decision');
 for(const patch of [
  {alternative:positiveReceipt.whole_film.focus+'。'},
  {alternative:'……。'},
  {evidence_id:samples[1].evidence.id,source_quote:samples[1].evidence.text},
  {affected_unit_ids:['green-0']},
  {status:'fix',affected_unit_ids:['not-a-current-unit']},
 ]){
  assert.throws(()=>validateTeachingBaselineReview({...positiveReceipt,whole_film:{...positiveReceipt.whole_film,...patch}},strictPositive),
   /teaching_whole_film_review_invalid/);
 }
 const unresolvedWholeFilm=validateTeachingBaselineReview({...positiveReceipt,whole_film:{...positiveReceipt.whole_film,status:'unresolved',
  main_point_id:null,evidence_id:null,source_quote:null,affected_unit_ids:['green-0']}},strictPositive);
 assert.equal(unresolvedWholeFilm.whole_film?.status,'unresolved');
 assert(unresolvedWholeFilm.units.every(unit=>unit.status==='ok'));
 assert.deepEqual(validateTeachingBaselineReview(unresolvedWholeFilm,strictPositive),unresolvedWholeFilm,'saved whole-film receipts can be read back');
 const uncertainty=teachingRebuild(strictPositive,old,{...unresolvedWholeFilm,whole_film:{...unresolvedWholeFilm.whole_film!,
  evidence_id:samples[0].evidence.id,source_quote:samples[0].evidence.text}});
 const evidenceClone={...strictPositive.evidence[0],id:'copy-of-existing-evidence'};
 assert(unchangedWholeFilmTeaching({...strictPositive,evidence:[...strictPositive.evidence,evidenceClone]},uncertainty));
 const newEvidence={...evidenceClone,text:'音轨另有可核购买建议，补足原来未确认的对象。'};
 assert.equal(unchangedWholeFilmTeaching({...strictPositive,evidence:[...strictPositive.evidence,newEvidence]},uncertainty),false,
  'real new evidence may resolve a whole-film uncertainty without rewriting the cited observation');
 const omittedReview=validateTeachingBaselineReview({...positiveReceipt,whole_film:{...positiveReceipt.whole_film,
  status:'fix',affected_unit_ids:['green-0'],reason:'整条遗漏了其他段落的选择依据。'}},strictPositive);
 const wholeFilmRebuild=teachingRebuild(strictPositive,old,omittedReview);
 assert(unchangedWholeFilmTeaching(strictPositive,wholeFilmRebuild));
 assert.deepEqual(unchangedRejectedTeaching(strictPositive,wholeFilmRebuild),[],'an omission is not a defect in an otherwise correct existing unit');
 const newGroup={...strictPositive.units[0],unit_id:'new-omitted-group'};
 const addedTopic={...strictPositive,units:[...strictPositive.units,newGroup]};
 assert.equal(unchangedWholeFilmTeaching(addedTopic,wholeFilmRebuild),false,'adding the omitted group is progress without rewriting the old one');
 assert(staleRebuiltTeaching(addedTopic,old,wholeFilmRebuild).includes(newGroup.unit_id),'a new teaching group cannot inherit old copy');
 for(const mode of ['missing','omission'] as const){
  const doc=structuredClone(firstCopyDoc);
  const analysis=doc.clipMentorAnalysis!;
  analysis.evidence.push({...visible,evidence_id:'fixture-unselected-result',text:'随后并排呈现两种结果，作者指向明显差异。'});
  const task=await taskFor('whole-film-'+mode,doc,2,'exemplar-v1');
  const stages:string[]=[];
  calls=[];
  wholeFilmAction=mode;
  await advanceProductionTask(task,async(t,ctx)=>{
   stages.push(t.stage);
   if(t.stage==='analysis')throw Error('fixture observes repair routing only');
   return productionStageWorker(t,ctx);
  });
  wholeFilmAction=undefined;
  assert.deepEqual(stages,mode==='missing'?['blueprint']:['blueprint','analysis']);
  assert.deepEqual(calls,['baseline']);
  if(mode==='missing')assert.match(task.error??'',/teaching_whole_film_review_invalid/);
  if(mode==='omission')assert.match(task.repairContext?.teaching_baseline_issue as string,/整片选题.*原片另有/);
  const saved=(await loadOfflineStoredProject(task.projectId))!;
  assert.equal(teachingDraftPointersDigest(saved.doc),teachingDraftPointersDigest(doc));
 }
 const duplicateConcern=structuredClone(firstCopyDoc);
 const duplicatePoint=duplicateConcern.clipMentorAnalysis!.source_breakdown!.points[0];
 duplicatePoint.teaching_basis!.selling_point=duplicatePoint.buying_concern+'。';
 const duplicateTask=await taskFor('advisory-duplicate-concern',duplicateConcern,1,'exemplar-v1');
 duplicateTask.input.panelDelivery!.selectionPolicy='v1';
 const duplicateSource=teachingBaselineSource(duplicateConcern,duplicateTask,[]);
 assert(duplicateSource.selection?.gaps.some(gap=>gap.includes('卖点与买家顾虑文案相同')));
 assert(!teachingPointGaps(duplicateSource,duplicateConcern).some(gap=>gap.includes('卖点与买家顾虑')));
 console.log('PASS whole-film omission and missing verdict stop first-copy authoring; duplicate concern points are advisory');
 const wrongQuote=structuredClone(positiveReceipt);
 wrongQuote.units[0].point_checks[0].source_quote=samples[1].evidence.text;
 assert.throws(()=>validateTeachingBaselineReview(wrongQuote,strictPositive),/point_source_quote_invalid/);
 const unregistered=structuredClone(positiveReceipt);
 unregistered.feedback_scope='baseline';
 const detail={...strictPositive.evidence[0],id:'unregistered-detail'};
 Object.assign(unregistered.units[0].point_checks[0],{source_evidence_id:detail.id,source_quote:detail.text});
 const withDetail={...strictPositive,evidence:[...strictPositive.evidence,detail]};
 assert.throws(()=>validateTeachingBaselineReview(unregistered,withDetail),/point_source_quote_invalid/,
  'a real excerpt in the same window still needs this point’s binding');
 const registered=structuredClone(withDetail);
 registered.units[0].points[0].teaching_basis!.evidence_ids.push(detail.id);
 assert.equal(validateTeachingBaselineReview(unregistered,registered).feedback_scope,'none');

 const legacyDigest=teachingBaselineDigest(strictPositive,true),operationId='fixture-initial-legacy';
 const legacyKey=`fixture:teaching-baseline:${legacyDigest}`;
 const legacyTask={...strictTask,effects:{[legacyKey]:{kind:'model' as const,operationId,status:'completed' as const,
  result:{digest:legacyDigest,runId:operationId,review:{...positiveReceipt,feedback_scope:'baseline'}}}}};
 const noResubmission={signal:new AbortController().signal,async effect(){throw Error('must not resubmit a legacy review');}};
 const reused=await checkTeachingBaseline(legacyTask,noResubmission,strictPositive);
 assert.equal(reused.digest,legacyDigest);
 assert.equal(reused.review.feedback_scope,'none');
 const failedLegacy={...legacyTask,effects:{[legacyKey]:{kind:'model' as const,operationId,status:'failed' as const}}};
 await assert.rejects(checkTeachingBaseline(failedLegacy,noResubmission,strictPositive),/prior_attempt_unresolved/);
 const missingPoint=structuredClone(positiveReceipt);
 missingPoint.units[0].point_checks=[];
 assert.throws(()=>validateTeachingBaselineReview(missingPoint,strictPositive),/point_review_incomplete/);
 const overallPass=structuredClone(positiveReceipt);
 overallPass.units[0].point_checks[0].status='fix';
 assert.equal(validateTeachingBaselineReview(overallPass,strictPositive).units[0].status,'fix');
 const copyFeedback={...strictPositive,feedback:{text:'第二句请精简。',revision:'reviewed-board'}};
 assert.equal(validateTeachingBaselineReview({...positiveReceipt,feedback_requires_baseline:false},copyFeedback).feedback_scope,'copy');
 assert.equal(validateTeachingBaselineReview({...overallPass,feedback_requires_baseline:false},copyFeedback).feedback_scope,'baseline');
 assert.throws(()=>validateTeachingBaselineReview({...positiveReceipt,feedback_requires_baseline:true},copyFeedback),/review_invalid/);
 const forcedRebuild=validateTeachingBaselineReview({...positiveReceipt,feedback_scope:'copy'},
  {...strictPositive,feedback:{text:'我觉得方向错了。',revision:'reviewed-board'}});
 assert.equal(forcedRebuild.feedback_scope,'baseline');
 assert(forcedRebuild.units.every(u=>u.status==='fix'));
 const scoped=validateTeachingBaselineReview({...positiveReceipt,feedback_scope:'copy'},
  {...strictPositive,feedback:{text:'第2组教学方向是错的。',revision:'reviewed-board',rejectedUnitIds:['green-1']}});
 assert.deepEqual(scoped.units.filter(unit=>unit.status==='fix').map(unit=>unit.unit_id),['green-1']);
 assert.throws(()=>validateTeachingBaselineReview({...positiveReceipt,feedback_scope:'copy'},
  {...strictPositive,feedback:{text:'第2组教学方向是错的。',revision:'stale-or-unbound-board'}}),/feedback_scope_unresolved/);
 const rebuildWithExemplar=teachingRebuild(strictPositive,old,forcedRebuild);
 const relabeled=structuredClone(strictPositive);
 relabeled.units[0].points[0].teaching_basis!.difference='仅重写范例笔记，没改变本组教学';
 assert.equal(unchangedRejectedTeaching(relabeled,rebuildWithExemplar).length,samples.length);
 assert.equal(exemplars.judydoll_copy.length,6);
 // Actual saved draft excerpts cannot be cited as original-video support for a new baseline.
 for(const [i,unit] of exemplars.judydoll_copy.entries()){
  const stale=structuredClone(positiveReceipt);
  stale.units[i].point_checks[0].source_quote=unit.lines[0].narration_ms;
  assert.throws(()=>validateTeachingBaselineReview(stale,strictPositive),/point_source_quote_invalid/,unit.unit_id);
 }
 console.log('PASS Green Makes six archived excerpts, TeaShell and NIUMO controls, JUDYDOLL revision 9 and six draft excerpts, and explicit direction rejection');

 const fixed={kind:'opening_comparison' as const,quote:'同样是拍这款商品，为什么这支视频拿到这些成绩？',
  results:{views:'339.32k',units:'135',revenue:'RM5.31k'}};
 assert.equal(panelOpeningComparison().results,undefined);
 const hook=(copy:string)=>({section_id:'opening',kind:'performance_opening',line:{line_id:'open',narration_ms:copy,caption_lines:[copy]},evidence_ids:['sale']}) as DeliverySection;
 const premise='Produk yang sama';
 const question='Kenapa video ini capai 339.32k tontonan, 135 unit terjual dan Revenue RM5.31k?';
 const opening=hook(`${premise}. ${question} Jom tengok caranya.`);
 const reviewRow={section_id:'opening',verdict:'pass',claims_supported:'supported',purpose_clear:true,reason:'receipt fixture',evidence_ids:['sale'],
  narration_checks:[{line_id:'open',necessity:'necessary',naturalness:'natural',omission_loss:'the question',reason:'present'}],
  opening_comparison:{status:'preserved',same_product_quote:premise,outcome_question_quote:question,invitation_quote:'Jom tengok caranya.',reason:'present'}};
 assert.equal(deliveryReview([opening],[reviewRow],fixed).verdict,'pass');
 const missingUnits=hook(opening.line.narration_ms.replace('135 unit terjual dan ',''));
 assert.equal(deliveryReview([missingUnits],[reviewRow],fixed).verdict,'needs_revision');
 const wrongMetric=hook(opening.line.narration_ms.replace('135 unit','135 komen'));
 assert.equal(confirmedOpeningResultsMatch(wrongMetric,fixed.results!),false,'A count of comments is not units sold');
 const reversedHook=hook(`${question} ${premise}. Jom tengok caranya.`);
 assert.notEqual(deliveryReview([reversedHook],[reviewRow],fixed).verdict,'pass','The comparison premise comes before the result question');
 const paddedHook=hook(`Ramai kreator sudah membuat video produk ini. ${opening.line.narration_ms}`);
 assert.equal(deliveryReview([paddedHook],[reviewRow],fixed).verdict,'insufficient_evidence','A separately added creator count premise cannot hide outside the cited opening');
 assert.equal(deliveryReview([paddedHook],[{...reviewRow,opening_comparison:{...reviewRow.opening_comparison,
  same_product_quote:`Ramai kreator sudah membuat video produk ini. ${premise}`}}],fixed).verdict,'insufficient_evidence','A citation cannot absorb a separate factual assertion');
 const splitHook=hook(`${premise}. ${question.replace(' dan Revenue RM5.31k','')} Revenue RM5.31k. Jom tengok caranya.`);
 assert.equal(deliveryReview([splitHook],[{...reviewRow,opening_comparison:{...reviewRow.opening_comparison,
  outcome_question_quote:question.replace(' dan Revenue RM5.31k','')}}],fixed).verdict,'insufficient_evidence','All three metrics belong to the result question itself');
 const insertedHook=hook(`${premise}. Semua kreator lain ketinggalan. ${question} Jom tengok caranya.`);
 assert.equal(deliveryReview([insertedHook],[reviewRow],fixed).verdict,'insufficient_evidence','the cited opening cannot skip an unsupported assertion between its premise and question');
 const appendedHook=hook(`${opening.line.narration_ms} Cara ini menggerakkan jualan.`);
 assert.equal(deliveryReview([appendedHook],[reviewRow],fixed).verdict,'insufficient_evidence','the cited opening must cover the spoken ending as well');
 assert.equal(deliveryReview([opening],[{...reviewRow,opening_comparison:{...reviewRow.opening_comparison,invitation_quote:undefined}}],fixed).verdict,'insufficient_evidence');
 for(const copy of [question.replace('135','1350'),question.replace('135','135.1'),question.replace('Revenue','GMV')])
  assert.equal(confirmedOpeningResultsMatch(hook(copy),fixed.results!),false);
 const cta={...opening,section_id:'new_contact',kind:'creator_invitation',picture:{asset_id:'cta',
  layout:{kind:'recruitment_card',poster:{asset_id:'cta',src:'/media/uploads/cta.png',sha256:'a'.repeat(64)}}}} as DeliverySection;
 const ctaResult={...reviewRow,section_id:'new_contact',ending_picture:{asset_id:'cta',view:'planned_composition',both_visible:'yes',observation:'The original poster shows both the palette and commission.'}};
 const genericOpening=panelOpeningComparison();
 assert.equal(deliveryReview([opening,cta],[reviewRow,{...ctaResult,ending_picture:undefined}],genericOpening,true).verdict,'insufficient_evidence',
  'A new web task without fixed performance numbers still needs an ending-picture judgment');
 assert.equal(deliveryReview([opening,cta],[reviewRow,ctaResult],genericOpening,true).verdict,'pass');
 assert.equal(deliveryReview([opening,cta],[reviewRow,{...ctaResult,ending_picture:{...ctaResult.ending_picture,view:'supplied_full'}}],genericOpening,true).verdict,'insufficient_evidence',
  'the uploaded image alone cannot certify the planned layout');
 assert.equal(deliveryReview([opening,cta],[reviewRow,ctaResult],fixed).verdict,'pass');
 assert.equal(deliveryReview([opening,cta],[reviewRow,{...ctaResult,ending_picture:{...ctaResult.ending_picture,asset_id:'other'}}],fixed).verdict,'insufficient_evidence');
 console.log('PASS frozen opening metrics and Revenue, unrelated product isolation, and ending-picture binding');

 // Replay another saved product through the new path, with a loopback review.
 // The adapter only adds the newly required fields and does not claim a new creative verdict.
 const other=structuredClone(known);
 const otherSource=teachingBaselineSource(other,knownTask,[]);
 const otherBreakdown=other.clipMentorAnalysis!.source_breakdown!;
 for(const point of otherBreakdown.points){
  const registered=breakdownPointEvidence(otherBreakdown,point.point_id);
  const visualOnly=otherBreakdown.units.some(unit=>unit.coverage.some(coverage=>coverage.point_id===point.point_id&&coverage.treatment==='visual_only'));
  const evidence=otherSource.evidence.find(item=>registered.includes(item.id)&&(!visualOnly||item.kind==='visible_action'))!;
  assert(evidence,point.point_id);
  point.teaching_basis={selling_point:evidence.text,evidence_ids:[evidence.id],method:evidence.text,
   connection:point.teaching_question,must_capture:evidence.text,claim_limit:'保留实际拍法和片中表达边界',
   exemplar:'buyer-first',difference:'原片证据来自本商品'};
 }
 const otherStrict=await taskFor('teaching-exemplar-barely-there',other,0,'exemplar-v1');
 const actionOnly=structuredClone(other);
 const firstPoint=actionOnly.clipMentorAnalysis!.source_breakdown!.points[0];
 firstPoint.teaching_basis!.connection=firstPoint.teaching_basis!.method+'。';
 assert(teachingPointGaps(teachingBaselineSource(actionOnly,otherStrict,[]),actionOnly).some(gap=>gap.startsWith(firstPoint.point_id+' ')),
  'Repeating the shot in the effect field must fail before authoring');
 const referenceDoc=structuredClone(other);
 const referenceBytes='frozen comparison fixture';
 const reference={id:'approved-example',name:'approved-example.mp4',kind:'video' as const,src:'/media/uploads/approved-example.mp4',
  sourceContentHash:createHash('sha256').update(referenceBytes).digest('hex'),durationInFrames:300,width:720,height:1280,
  props:{clipmentorReferenceOnly:true}};
 referenceDoc.assets.push(reference);
 const referencesTask=await taskFor('teaching-exemplar-bound-reference',referenceDoc,0,'exemplar-v1');
 const {uploadDir}=await import('../media-dir');
 const referenceFile=join(uploadDir(),reference.name);
 await mkdir(uploadDir(),{recursive:true});
 await writeFile(referenceFile,referenceBytes);
 const criteria={id:'look-at-the-gesture',sectionId:otherBreakdown.units[0].unit_id,layout:'native_composition',pictureStage:'explanation',
  quote:'先展示买家能直接观察的结果',question:'讲解是否让人看清动作和结果的关系？',reference:{assetId:reference.id,seconds:2,fileName:reference.name}};
 await registerHandoff({projectId:referencesTask.projectId,expectedProjectRevision:referencesTask.projectRevision,previousDigest:null,
  brief:{version:1,briefId:'teaching-reference',revision:1,mode:'autonomous',phase:'planning',planner:'builtin_agent',executor:'builtin_agent',
   projectId:referencesTask.projectId,timelineId:referenceDoc.activeTimelineId,objective:'Exercise current teaching references',
   doneCriteria:[criteria],blueprint:null,budget:{maxModelTurns:6,maxToolCalls:20,maxElapsedMs:120_000,paidToolCalls:{}}}});
 const priorReferencePolicy=(await readHandoffPolicy(referencesTask.projectId))!;
 const reboundReferencePolicy=structuredClone(priorReferencePolicy);
 reboundReferencePolicy.assetBindings.find(asset=>asset.id===reference.id)!.sourceContentHash='e'.repeat(64);
 assert.notEqual(panelBlueprintRequirementsDigest(priorReferencePolicy),panelBlueprintRequirementsDigest(reboundReferencePolicy),
  'rebinding the same reference ID must invalidate the old board requirement digest');
 const author=await productionAuthorTaskData(referencesTask,referenceDoc);
 const analysisAuthor=await productionAuthorTaskData({...referencesTask,stage:'analysis'},referenceDoc);
 for(const taskData of [author,analysisAuthor])assert.match(taskData.teachingExemplars??'',/为何本片不宜套用范例做法/);
 assert.match(analysisAuthor.teachingSelection??'',/先按证据盘点完整原片.*根据选中的单元概括/);
 assert.match(author.teachingSelection??'',/先估保留这些信息所需的最短完整时段/);
 assert.match(analysisAuthor.teachingSelection??'',/比较最强的另一个讲法/);
 assert.match(author.teachingSelection??'',/最短完整时段，再找逐句窗口/);
 assert.deepEqual(author.teachingReferences?.references,[{id:criteria.id,sectionId:criteria.sectionId,pictureStage:criteria.pictureStage,
  quote:criteria.quote,question:criteria.question,reference:{...criteria.reference,sha256:reference.sourceContentHash}}]);
 await assert.rejects(()=>productionAuthorTaskData({...referencesTask,input:{...referencesTask.input,openingComparison:fixed}},referenceDoc),
  /source_performance_declaration_required/,'numeric legacy opening cannot silently identify another project');
 assert(!author.doneCriteria?.includes('把原话、画面证据、达人能学什么和讲解怎么承载都做实'),'product-specific user quote must not drift to another project');
 const changedReference=structuredClone(referenceDoc);
 changedReference.assets.at(-1)!.props={};
 await assert.rejects(()=>productionAuthorTaskData(referencesTask,changedReference),/handoff_teaching_reference_unbound/);
 await writeFile(referenceFile,'different reference bytes');
 calls=[];await advanceProductionTask(referencesTask,productionStageWorker);
 assert.match(referencesTask.error??'',/handoff_visual_reference_changed/);
 assert.deepEqual(calls,[],'a stale teaching reference is rejected before a baseline or author request');
 assert.equal(referencesTask.attempts.model,0);
 calls=[];await advanceProductionTask(otherStrict,productionStageWorker);
 assert.deepEqual(calls,['baseline','author'],'another product passes the new review contract before reaching the drafting call');
 assert.equal(otherStrict.attempts.review,0);
 console.log('PASS Barely There cold project runs the strict baseline and reaches draft with a local provider');

 const resumed=await taskFor('teaching-exemplar-approved-output',other,0,'exemplar-v1');
 resumed.input.panelDelivery!.audience='existing_partner';
 // Opening a downstream repair must inherit the exact common teaching basis
 // saved by the parent's approval, not trust its own current draft.
 const basisDigest=confirmedTeachingDigest(other);
 const approval:NonNullable<ProductionTask['blueprintApproval']>={sourceProjectId:otherStrict.projectId,sourceTaskId:otherStrict.taskId,sourceRevision:otherStrict.projectRevision!,
  digest:(await copyReviewSubject(other)).digest,requirementsDigest:'a'.repeat(64),confirmedAt:Date.now(),confirmedTeachingDigest:basisDigest};
 resumed.blueprintApproval=approval;
 const missingScope={...resumed,stage:'copy_review' as const};
 await assert.rejects(productionStageWorker(missingScope,{signal:new AbortController().signal,
  async effect(){throw Error('provider called');}}),/production_confirmed_groups_missing/);

 const mutated=structuredClone(other);
 mutated.clipMentorAnalysis!.source_breakdown!.points[0].teaching_question='某次返修把共同教学问题改成了另外一件事？';
 await setStoredEntry('project:'+resumed.projectId,mutated);
 resumed.projectRevision=revisionOf(mutated);
 calls=[];
 await assert.rejects(productionStageWorker(resumed,{signal:new AbortController().signal,async effect(){throw Error('provider called');}}),
  /production_confirmed_teaching_baseline_changed/);
 const changedEvidence=structuredClone(other);
 const evidenceId=changedEvidence.clipMentorAnalysis!.source_breakdown!.points[0].teaching_basis!.evidence_ids[0];
 const sourceEvidence=changedEvidence.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===evidenceId)!;
 changedEvidence.clipMentorAnalysis!.evidence.push({...sourceEvidence,evidence_id:'unrelated-supplement'});
 assert.equal(confirmedTeachingDigest(changedEvidence),basisDigest);
 sourceEvidence.text+=' The same evidence ID now has different facts.';
 assert.notEqual(confirmedTeachingDigest(changedEvidence),basisDigest);
 const withSupport=structuredClone(other);
 const supported=withSupport.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===evidenceId)!;
 const frameEvidence=withSupport.clipMentorAnalysis!.evidence.find(e=>e.kind==='source_frame')!;
 const support={...frameEvidence,evidence_id:'supporting-source-position',supporting_evidence_ids:[]};
 withSupport.clipMentorAnalysis!.evidence.push(support);
 supported.supporting_evidence_ids.push(support.evidence_id);
 const supportedApproval=confirmedTeachingDigest(withSupport);
 support.text+=' changed behind the same ID';
 assert.notEqual(confirmedTeachingDigest(withSupport),supportedApproval,'a selected observation cannot approve different supporting evidence behind the same ID');
 approval.confirmedTeachingDigest=supportedApproval;
 await setStoredEntry('project:'+resumed.projectId,withSupport);
 resumed.projectRevision=(await loadOfflineStoredProject(resumed.projectId))!.revision;
 await assert.rejects(productionStageWorker(resumed,{signal:new AbortController().signal,async effect(){throw Error('provider called');}}),
  /production_confirmed_teaching_baseline_changed/);
 // An existing policy-v1 continuation may predate the persisted digest. Its
 // original approved project revision is enough to recover, without a provider request.
 delete approval.confirmedTeachingDigest;
 await setStoredEntry('project:'+resumed.projectId,other);
 resumed.projectRevision=revisionOf(other);
 await assert.rejects(productionStageWorker(resumed,{signal:new AbortController().signal,async effect(){throw Error('fixture author boundary');}}),
  /fixture author boundary/);
 approval.sourceRevision='stale-parent-revision';
 await assert.rejects(productionStageWorker(resumed,{signal:new AbortController().signal,async effect(){throw Error('provider called');}}),
  /production_confirmed_teaching_baseline_changed/);
 assert.deepEqual(calls,[]);
 console.log('PASS downstream output repairs preserve the shared approved teaching baseline');
 const cardLabels=['BT-02 · Barely There','GM-04 · Green Makes','TS-05 · TeaShell','NM-04 · NIUMO'];
 for(const stage of ['analysis','blueprint']){
  const prompt=authorPrompts.get(stage);
  assert(prompt,`missing real ${stage} author request`);
  assert(prompt.includes(teachingPurpose.audience)&&prompt.includes(teachingPurpose.review_question),`${stage} must receive the shared purpose`);
  for(const boundary of teachingPurpose.boundaries)assert(prompt.includes(boundary));
  for(const label of cardLabels)assert(prompt.includes(label),`${stage} author missing ${label}`);
  if(stage==='blueprint'){
   assert.match(prompt,/planning\.md 的 Before drafting the narration/);
   assert.match(prompt,/只读实际马来语.*拍摄选择.*观众当场得到的具体信息或想弄清的问题/);
   assert(prompt.includes('What does that choice immediately let the viewer notice, understand or want to find out?'),
    'the live author request includes the fact-card drafting method');
  }
 }
 assert(independentPrompts.length>0,'the fake service must receive a real independent review request');
 for(const prompt of independentPrompts){
  if(!prompt.includes('旧版审核只问讲解是否清晰。'))
   assert(prompt.includes(teachingPurpose.review_question),'independent baseline and narration requests must receive the shared purpose');
  for(const boundary of teachingPurpose.boundaries)assert(prompt.includes(boundary));
  assert(!prompt.includes('人工拆解单元：同一主题怎样讲得具体'));
  assert(!prompt.includes('What does that choice immediately let the viewer notice, understand or want to find out?'),
   'independent review reads the candidate without the author’s drafting instructions');
  for(const label of cardLabels)assert(!prompt.includes(label));
  for(const sample of humanTeachingCalibration){
   for(const answer of [sample.useful,sample.actionOnly,sample.overclaim])assert(!prompt.includes(answer));
  }
 }
 console.log('PASS production authors receive the four cards while independent baseline review receives no exemplar answers');
}finally{
 globalThis.fetch=realFetch;
 host.closeAllConnections();await new Promise<void>(resolve=>host.close(()=>resolve()));
 if(prior===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=prior;
 await rm(path,{recursive:true});
}
