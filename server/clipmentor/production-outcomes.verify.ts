import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash}from'node:crypto';
import {projectDoc}from'../external-agent/offline-runtime.verify-fixtures';
import {productionDeliverables,productionAttachmentSlots}from'./production-deliverables';
import {assertFinalPreviewEvidence}from'./production-preview-facts';
import {boundVisualCriteria,plannedVisualCriteria,assertVisualCriteriaPlan,visualCriteriaPlanApproved}from'./visual-done-criteria';
import {parseHandoffBrief,type HandoffPolicy}from'../../shared/clipmentor-handoff';
import type{ProductionTask}from'./production-task';
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const criterion={id:'source-style',quote:'本项目的原片标识沿用认可版式。',question:'实际原片标识是否沿用本项目认可版式？',sectionId:'U02',layout:'native_composition' as const,pictureStage:'原片',reference:{assetId:'ref',fileName:'reference.png',seconds:0}};
const brief=parseHandoffBrief({version:1,briefId:'outcome',revision:1,mode:'autonomous',phase:'planning',planner:'builtin_agent',executor:'builtin_agent',projectId:'fixture',timelineId:'tl',objective:'Verify delivered outcomes',blueprint:null,doneCriteria:[criterion],budget:{maxModelTurns:0,maxToolCalls:0,maxElapsedMs:1000,paidToolCalls:{}}});
const policy={brief,assetBindings:[{id:'ref',kind:'image',src:'/media/uploads/ref.png',sourceContentHash:'a'.repeat(64)}]}as HandoffPolicy;
const bound=boundVisualCriteria(policy)!;assert.equal(bound.entries[0].criterion.quote,criterion.quote);
assert.doesNotThrow(()=>assertVisualCriteriaPlan(bound,[],['U02']));
assert.throws(()=>assertVisualCriteriaPlan(bound,[],['U01']),/criterion_unresolved/,'missing requested unit must not silently disappear');
const whole=structuredClone(bound);whole.entries[0].criterion.sectionId='tl';
assert.doesNotThrow(()=>assertVisualCriteriaPlan(whole,[],['U01','U02','U03','U04','U05'],'tl'));
assert.throws(()=>assertVisualCriteriaPlan(whole,[],['U01'],'other'),/unresolved/);
assert.equal(plannedVisualCriteria(bound),undefined,'native screen acceptance belongs to rendered output, not source samples');
assert.equal(visualCriteriaPlanApproved(bound,{verdict:'pass'}),true,'ordinary teaching approval still allows execution; it is not final acceptance');
const task={projectId:'fixture',projectRevision:'saved',completed:{export:{at:1,artifact:{revision:'saved',path:'/media/uploads/preview.mp4'}},self_check:{at:2,artifact:{preview:'/media/uploads/preview.mp4',receipt:{projectId:'fixture',videoSha256:'b'.repeat(64),scope:'rendered_preview_continuous_review',status:'completed',full_film_accepted:false,effective_review:{status:'pass',can_use_as_pass:true,blockers:[],manifest_binding:'frozen_at_request'},timeline_check:{status:'no_detected_conflict'}}}}}}as ProductionTask;
assert.doesNotThrow(()=>assertFinalPreviewEvidence(task,'saved','b'.repeat(64)));
for(const mutate of [
 (t:ProductionTask)=>{delete t.completed.self_check!.artifact.receipt;},
 (t:ProductionTask)=>{(t.completed.self_check!.artifact.receipt as any).scope='copy_and_planned_picture_only';},
 (t:ProductionTask)=>{(t.completed.self_check!.artifact.receipt as any).projectId='foreign';},
 (t:ProductionTask)=>{(t.completed.self_check!.artifact.receipt as any).effective_review.can_use_as_pass=false;},
 (t:ProductionTask)=>{(t.completed.self_check!.artifact.receipt as any).effective_review.blockers=['unresolved'];},
 (t:ProductionTask)=>{t.completed.self_check!.artifact.preview='/media/uploads/old.mp4';},
]){const bad=structuredClone(task);mutate(bad);assert.throws(()=>assertFinalPreviewEvidence(bad,'saved','b'.repeat(64)),/missing_or_stale/);}
assert.throws(()=>assertFinalPreviewEvidence(task,'changed','b'.repeat(64)),/missing_or_stale/);
assert.throws(()=>assertFinalPreviewEvidence(task,'saved','c'.repeat(64)),/missing_or_stale/,'a current checkbox cannot approve a different video');
const root=await mkdtemp(join(tmpdir(),'clipmentor-outcome-files-'));
try{
 const attachment=await sharp({create:{width:4,height:4,channels:3,background:'#123456'}}).png().toBuffer();await writeFile(join(root,'attachment.png'),attachment);
 const d=projectDoc(),sha=hash(attachment),sourceSha='f'.repeat(64);
 const ref=(id:string,sha256='a'.repeat(64))=>({asset_id:id,src:`/media/uploads/${id}.png`,sha256});
 const layout={kind:'product_storyboard',product:ref('product'),storyboard:ref('board'),attachment:ref('attachment',sha)};
 d.assets=['card','product','board','attachment'].map(id=>({id,kind:'image',src:`/media/uploads/${id}.png`,width:720,height:1280,durationInFrames:1,sourceContentHash:id==='attachment'?sha:'a'.repeat(64),props:{clipmentorStoryboardSource:'original',clipmentorStoryboardHash:sourceSha}}));
 d.clipMentorAnalysis={product:{name:'JUDYDOLL'},source:{asset_id:'original',sourceContentHash:sourceSha},evidence:[{evidence_id:'business',kind:'operator_supplied',source_ids:['card'],text:'Storyboard and product reference'}],blueprint:[{unit_id:'U02',internal_review:{current_picture_plan:'p',p:{delivery_sections:[{section_id:'existing_partner',kind:'creator_invitation',evidence_ids:['business'],line:{line_id:'EP',narration_ms:'Jom rakam.',caption_lines:['Jom rakam.'],meaning_zh:'开始拍摄。',labels:[]},picture:{...ref('card'),description:'Product and own storyboard',layout},voice:{provider:'fixture',voiceId:'fixture',speed:1}}]}}}]}as never;
 d.clipMentorAnalysis!.source.duration_seconds=1;d.clipMentorAnalysis!.source.fps=30;d.clipMentorAnalysis!.evidence.push({evidence_id:'speech',kind:'original_claim',text:'Ini warna.',source_ids:['original'],supporting_evidence_ids:[],status:'candidate',source_range_seconds:[0,1]});d.clipMentorAnalysis!.source_breakdown={segments:[{segment_id:'source',source_range_seconds:[0,1],claim_evidence_ids:['speech']}],units:[{original_segment_ids:['source']}]} as never;
 d.clipMentorAnalysis!.evidence.push({evidence_id:'visible',kind:'visible_action',text:'A palette is shown.',source_ids:['original'],supporting_evidence_ids:[],status:'fixture',source_range_seconds:[0,1]});
 d.assets.push({id:'original',kind:'video',src:'/media/uploads/original.mp4',sourceContentHash:sourceSha,props:{}});
 d.assets.at(-1)!.props!.clipmentorCreatorStoryboard={source_sha256:sourceSha,rows:[{source_range_seconds:[0,1],source_frames:[0],shot_ms:'Dia menunjukkan palet.',information_ms:'Ini warna.',visible_evidence_ids:['visible'],claim_evidence_ids:['speech']}]};
 const pdf=Buffer.from('%PDF-1.4 fixture derivative');
 const before=JSON.stringify(d);let reads=0,renders=0;const io={storyboard:async()=>{renders++;return {bytes:pdf,preview:attachment,pages:1};},resolve:(name:string)=>join(root,name),read:async(file:string)=>{reads++;return readFile(file);}};
 await productionAttachmentSlots(d,io);assert.equal(renders,0,'ordinary status metadata never renders PDF frames');reads=0;
 const files=await productionDeliverables(d,io);assert.equal(files.length,1);assert.equal('src'in files[0],false,'a PDF record cannot pretend its bytes live at the PNG URL');assert.equal(reads,1,'read only current required output, not every old storyboard in the pool');assert.deepEqual(files[0].bytes,pdf);assert.equal(files[0].sha256,hash(pdf));assert.match(files[0].fileName,/Storyboard_.*\.pdf$/);assert.equal(JSON.stringify(d),before);
 await writeFile(join(root,'attachment.png'),'wrong bytes');await assert.rejects(productionDeliverables(d,io),/output_changed/);
 await rm(join(root,'attachment.png'));await assert.rejects(productionDeliverables(d,io),'pool registration without bytes cannot certify delivery');
 assert.deepEqual(await productionDeliverables(projectDoc(),io),[],'a scoped task with no attachment does not require one');
 console.log('Production outcomes: native requirement scope, actual preview identity, missing/negative/stale evidence, actual output bytes and scoped compatibility passed; no external calls or project writes');
}finally{await rm(root,{recursive:true,force:true});}
