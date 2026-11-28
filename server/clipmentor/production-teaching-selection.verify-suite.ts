import assert from 'node:assert/strict';
import type { ProjectDoc } from '../../src/editor/types';
import type { AnalysisEvidence } from '../../src/clipmentor/analysis';
import { checkSourceBreakdown, copyLineSourceBinding, isSourceBreakdown, type SourceBreakdown } from '../../src/clipmentor/source-breakdown';
import { teachingReplayRisks } from '../../src/clipmentor/blueprint-lint';
import { validatePicturePlanProjection } from '../../src/clipmentor/production-gate';
import { teachingSelectionGaps } from '../../src/clipmentor/teaching-selection';
import { baselineInstructions, confirmedTeachingDigest, qualifiedTeachingDigest, teachingBaselineSource, teachingPointGaps, validateTeachingBaselineReview } from './production-teaching-baseline';
import { blockedProductionDecision, firstGlanceReceiptError } from './production-decisions';
import { canResumeFirstGlanceReview } from './production-blueprint-recovery';
import type { ProductionTask } from './production-task';
import fixture from './fixtures/judydoll-teaching-selection.json';

const range = (id: string) => fixture.windows.find(window => window.id === id)!.range as [number, number];
const useAlternative = {decision:'压缩较长的试用过程，保留对刷头落位有用的步骤。',
 reason:'现有盘点支持继续核查使用动作，完整用法和顺序先保留为备选。',segment_ids:['use']};
const confirmedClosing = '收尾线索按已有事实记录。';

export function verifyTeachingSelections(template: ProjectDoc, templateTask: ProductionTask) {
 const doc = structuredClone(template), analysis = doc.clipMentorAnalysis!;
 analysis.source.duration_seconds = fixture.duration;
 analysis.evidence = fixture.windows.flatMap((window): AnalysisEvidence[] => window.observation ? [{
  evidence_id:'V-'+window.id, kind:'visible_action', text:window.observation,
  status:'agent_observed_candidate', source_range_seconds:range(window.id), supporting_evidence_ids:[], source_ids:[],
  observation_method:'isolated_visible_excerpt_fixture',call_status:'unknown',
 }] : []);
 const point = (id:string, buying_concern:string, teaching_question:string, connection:string):SourceBreakdown['points'][number] => {
  const visible=analysis.evidence.find(item=>item.evidence_id==='V-'+id)!;
  return {point_id:id,segment_ids:[id],buying_concern,teaching_question,filming_conditions:[visible.text],
   role:'primary',importance:'must_explain',teaching_basis:{selling_point:'实物展示提供本组购买判断的参照。',evidence_ids:[visible.evidence_id],
    method:visible.text,connection,must_capture:visible.text,claim_limit:'只讲可见的展示次序或位置，不推定动机、配方或销售效果。',
    exemplar:'buyer-first',difference:'借表达判断，观察范围来自本片。'}};
 };
 const baseline:SourceBreakdown = {
  version:1, review_scope:{kind:'full_source',instruction:'核对全片选题与声画窗口。'},
  segments:fixture.windows.map(window=>({segment_id:window.id,source_range_seconds:range(window.id),
   visible_evidence_ids:window.observation?['V-'+window.id]:[],claim_evidence_ids:[],interpretation_evidence_ids:[],
   unknowns:window.unknown?[window.unknown]:[],inventory:{function:window.function,
    tracks:{picture:window.observation??'unknown',speech:'unknown',captions:'unknown',sound:'unknown'},emphasis:window.emphasis}})),
  points:[point('hook','上脸结果能否吸引继续看','为什么用上脸结果开场能给买家一个继续看的理由？','先看实际呈现，再识别随后的粉盘。'),
   point('palettes','盘内颜色对应哪个编号','为什么同框带码能让买家把颜色对回编号？','颜色和编号在同一画面能够逐一核对。'),
   point('nose','颜色落在脸部哪里','为什么应在刷头移开后补一个上脸参照？','皮肤上的颜色位置给出实际妆面参照。')],
  units:[{unit_id:'opening-to-palettes',original_segment_ids:['hook','palettes'],explanation_segment_ids:['hook','palettes'],
   coverage:[{point_id:'hook',treatment:'explain'},{point_id:'palettes',treatment:'explain'}],revisits:[],
   teaching_selection:{decision:'先给上脸结果和反应，随后把两盘及各自号码拍进同一镜。',
    omission_loss:'会少学从结果抓住注意再交代颜色身份的安排。',buyer_roles:['interest','reassurance'],basis:'observed',
    alternative:useAlternative,sequence_segment_ids:['hook','palettes']}},
   {unit_id:'nose-reference',original_segment_ids:['nose'],explanation_segment_ids:['nose'],
    coverage:[{point_id:'nose',treatment:'explain'}],revisits:[],
    teaching_selection:{decision:'刷头动作后补带鼻侧落位的上脸参照。',omission_loss:'会少学怎样让买家知道颜色落在脸上哪里。',
     buyer_roles:['reassurance'],basis:'observed',alternative:useAlternative}}],
 };
 analysis.source_breakdown=baseline;
 const line=(id:string,spoken:string,window:[number,number])=>({id,point_ids:[id],narration_ms:spoken,
  caption_lines:[spoken],zh:'离线回归占位释义。',source_seconds:window,labels:[]});
 const captionLines=[line('hook',fixture.hookDraft,[0,2.067]),line('palettes',fixture.paletteDraft,[7.8,9.7]),
  line('nose',fixture.savedNose,[34.3,36.3])];
 const installDraft = (target:ProjectDoc, lines:typeof captionLines, disposition:boolean) => {
  const targetAnalysis=target.clipMentorAnalysis!;
  targetAnalysis.blueprint=targetAnalysis.source_breakdown!.units.map(unit=>{
   const ids=unit.coverage.map(entry=>entry.point_id), selected=lines.filter(entry=>ids.includes(entry.id));
   unit.revisits=selected.map(entry=>({from_segment_id:entry.id,to_segment_id:entry.id,reason:'回看这句的原片依据。'}));
   return {unit_id:unit.unit_id,point_ids:ids,intent_zh:'测试源窗',line_guidance:'回看本句依据',internal_review:{
    current_script_candidate:'script_candidate_fixture',current_picture_plan:'picture_plan_fixture',
    script_candidate_fixture:{lines:selected},picture_plan_fixture:{script_candidate_id:'script_candidate_fixture',
     phases:selected.flatMap(entry=>[{mode:'original',source_range_seconds:range(entry.id),picture:'原片'},
      {mode:'explanation',line_id:entry.id,source_range_seconds:entry.source_seconds,picture:'本句原片依据'}]),
     ...(disposition?{timing_dispositions:selected.map(entry=>({line_id:entry.id,action:'hold_for_measurement',
      reason:'动态画面不足，需量声长并核对额外参照是否承担本句读图任务。'}))}:{}),
    },
   }};
  });
  targetAnalysis.points=targetAnalysis.source_breakdown!.points.map(point=>({
   point_id:point.point_id,unit_id:targetAnalysis.blueprint.find(unit=>unit.point_ids.includes(point.point_id))!.unit_id,
   source_range_seconds:range(point.point_id),buying_reason_or_function:point.buying_concern,
   filming_conditions:point.filming_conditions,evidence_ids:point.teaching_basis!.evidence_ids,uncertainties:[],
   required:true,explanation_priority:'原片教学重点',status:'candidate',review_status:'pending',provenance:'isolated fixture',
  }));
 };
 const firstUnit=baseline.units[0];
 assert.deepEqual(teachingSelectionGaps(baseline,fixture.duration,30),[]);
 assert(!checkSourceBreakdown(doc).issues.some(issue=>issue.code==='segment_without_evidence'),
  'the unselected inventory can keep an unknown window without made-up evidence');
 for(const line of captionLines.slice(0,2))assert.deepEqual(copyLineSourceBinding(baseline,firstUnit,line,{}),{
  evidence_source_ranges:[{segment_id:line.id,source_range_seconds:line.source_seconds}],context_source_ranges:[],
 });
 const combinedLine={...captionLines[0],point_ids:['hook','palettes'],source_seconds:[0,9.7]};
 const combinedPlan={phases:[{line_id:combinedLine.id,context_source_ranges:captionLines.slice(0,2).map(line=>({
  segment_id:line.id,source_range_seconds:line.source_seconds,purpose:'本句前后关系的实际证据',
 }))}]};
 assert.deepEqual(copyLineSourceBinding(baseline,firstUnit,combinedLine,combinedPlan),{
  evidence_source_ranges:captionLines.slice(0,2).map(line=>({segment_id:line.id,source_range_seconds:line.source_seconds})),
  context_source_ranges:[],
 });
 assert.equal(copyLineSourceBinding(baseline,firstUnit,{...combinedLine,point_ids:['hook','use']},combinedPlan),null);
 const onlyCandidate=structuredClone(baseline);
 delete onlyCandidate.units[0].teaching_selection!.alternative;
 assert(isSourceBreakdown(onlyCandidate),'a valid observation need not invent an alternative');
 assert.deepEqual(teachingSelectionGaps(onlyCandidate,fixture.duration,30),[]);
 const swapped=structuredClone(baseline);
 swapped.units[0].teaching_selection!.sequence_segment_ids!.reverse();
 assert(teachingSelectionGaps(swapped,fixture.duration,30).some(gap=>gap.includes('原片顺序')));
 const absent=structuredClone(baseline);
 delete absent.segments.at(-1)!.inventory;
 assert(teachingSelectionGaps(absent,fixture.duration,30).some(gap=>gap.includes('四轨盘点')));

 const task=structuredClone(templateTask);
 task.input.panelDelivery!.selectionPolicy='v1';
 task.stage='copy_review';
 const reassurance=structuredClone(doc);
 const onlyReassurance=reassurance.clipMentorAnalysis!.source_breakdown!;
 onlyReassurance.points=onlyReassurance.points.filter(point=>point.point_id!=='hook');
 onlyReassurance.units[0]={...onlyReassurance.units[0],original_segment_ids:['palettes'],explanation_segment_ids:['palettes'],
  coverage:[{point_id:'palettes',treatment:'explain'}],teaching_selection:{...firstUnit.teaching_selection!,
   decision:'把盘内颜色和号码拍在一镜。',buyer_roles:['reassurance'],sequence_segment_ids:undefined}};
 installDraft(reassurance,[line('palettes',fixture.savedPalette,[7.8,9.7]),captionLines[2]],false);
 assert(taSource(reassurance).selection?.gaps.some(gap=>gap.includes('想试层')));
 const missingRole=structuredClone(reassurance);
 onlyReassurance.unselected_buyer_roles={interest:'有关使用过程的证据和反应仍待核，保留在盘点中。'};
 assert.deepEqual(taSource(reassurance).selection?.gaps,[]);
 const duplicate=structuredClone(doc);
 duplicate.clipMentorAnalysis!.source_breakdown!.units[1].teaching_selection!.decision=firstUnit.teaching_selection!.decision+'。';
 assert(taSource(duplicate).selection?.gaps.some(gap=>gap.includes('同一个拍摄决定')));

 const overruns=teachingReplayRisks(reassurance);
 assert.deepEqual(overruns.map(({line_id,dynamic_seconds,disposition})=>[line_id,dynamic_seconds,disposition]),[
  ['palettes',1.9,null],['nose',2,null],
 ]);
 assert.doesNotThrow(()=>validatePicturePlanProjection({timing_dispositions:'待实测',phases:[{
  mode:'explanation',line_id:'palettes',source_range_seconds:[7.8,9.7],picture:'用本句原片依据',
 }]}),'free-form timing advice does not invalidate a supported picture plan');
 installDraft(doc,captionLines,true);
 const source=taSource(doc);
 assert(source.selection!.timingRisks!.length>=2);
 assert(source.selection!.timingRisks!.every(risk=>risk.disposition?.action==='hold_for_measurement'));
 assert.deepEqual(checkSourceBreakdown(doc).issues,[]);
 assert(baseline.segments.at(-1)!.unknowns.length);
 const changed=structuredClone(doc);
 changed.clipMentorAnalysis!.evidence.find(e=>e.evidence_id==='V-use')!.text+=' 增加独立可见动作。';
 assert.notEqual(confirmedTeachingDigest(changed),confirmedTeachingDigest(doc));

 const [main]=baseline.points, visible=analysis.evidence.find(item=>item.evidence_id==='V-hook')!;
 const receipt = (input:typeof source, rejectInference:boolean) => ({feedback_scope:'none',summary:'ok',
  whole_film:{status:'ok',main_point_id:main.point_id,focus:'用可见结果接到商品识别。',alternative:'独立拆解实际取粉用法。',
   reason:'原片顺序能复查到两个不同的可见环节。',evidence_id:visible.evidence_id,source_quote:visible.text,affected_unit_ids:[]},
  units:input.units.map(unit=>({unit_id:unit.unit_id,status:'ok',source_role:'表达购买理由',takeaway:'从实际源窗回读拍法决策。',
   evidence_ids:[unit.points[0].teaching_basis!.evidence_ids[0]],reason:confirmedClosing,
   point_checks:unit.points.map(point=>({point_id:point.point_id,status:'ok',learner_takeaway:'选择可核的拍摄参照。',
    connection:point.teaching_basis!.connection,question_quote:point.teaching_question,source_evidence_id:point.teaching_basis!.evidence_ids[0],
    source_quote:input.evidence.find(item=>item.id===point.teaching_basis!.evidence_ids[0])!.text}))})),
  narration_checks:input.narrationTargets!.map(target=>({unit_id:target.unit_id,point_id:target.point_id,
   status:rejectInference&&target.point_id==='hook'?'fix':'ok',
   ...(rejectInference&&target.point_id==='hook'?{baseline_criterion:{field:'claim_limit',
    quote:input.units.find(unit=>unit.unit_id===target.unit_id)!.points.find(point=>point.point_id===target.point_id)!.teaching_basis!.claim_limit}}:{}),
   reason:rejectInference&&target.point_id==='hook'?'把吸引观众的剪辑动机写成了已观察的事实。':'可从该句回读本组安排。',
   line_id:target.lines[0].line_id,quote:target.lines[0].narration,decision:'调整出镜和参照的顺序。',
   viewer_basis:'可核对本组要交代的颜色和位置。'})),
 });
 const positive=validateTeachingBaselineReview(receipt(source,false),source);
 assert(positive.units.every(unit=>unit.status==='ok')&&positive.narration_checks!.every(check=>check.status==='ok'));
 const inference=structuredClone(doc);
 installDraft(inference,[line('hook',fixture.inferenceDraft,[0,2.067]),...captionLines.slice(1)],true);
 const inferred=taSource(inference), negative=validateTeachingBaselineReview(receipt(inferred,true),inferred);
 assert.equal(negative.whole_film!.status,'ok');
 assert.equal(negative.narration_checks!.filter(check=>check.status==='fix')[0].quote,fixture.inferenceDraft);
 assert.throws(()=>validateTeachingBaselineReview(receipt(inferred,true),source),/teaching_final_narration_receipt_invalid/);
 const withBrief=structuredClone(doc);
 installDraft(withBrief,[{...captionLines[0],narration_ms:'Dia buka dengan solekan dan reaksi. Terus nak tahu dia guna apa.'},
  ...captionLines.slice(1)],true);
 const writingTask=structuredClone(task);
 writingTask.input.panelDelivery!.firstGlanceWriting=true;
 const briefSource=()=>teachingBaselineSource(withBrief,writingTask,[]);
 assert(briefSource().firstGlanceWriting);
 assert.equal(briefSource().firstGlanceWriting?.filter(unit=>!unit.first_glance).length,2);
 assert(teachingPointGaps(briefSource(),withBrief).some(issue=>issue.includes('缺一眼效果')));
 const writingUnits=withBrief.clipMentorAnalysis!.source_breakdown!.units;
 writingUnits[0].teaching_selection!.first_glance='她先用妆效和表情让人好奇用了什么，再让双盘和编号同框，颜色对回编号。';
 writingUnits[1].teaching_selection!.first_glance='她分部位留住工具和脸同框的短镜头，达人能认出落点。';
 writingUnits[0].teaching_selection!.hook_curiosity={point_id:'hook',question:'她用了什么？'};
 assert.notEqual(qualifiedTeachingDigest(withBrief),qualifiedTeachingDigest(doc),'a changed writing brief needs requalification');
 const checkedSource=briefSource();
 assert.deepEqual(checkedSource.narrationTargets?.filter(target=>target.hook_curiosity).map(target=>target.point_id),['hook']);
 assert(!teachingPointGaps(checkedSource,withBrief).some(issue=>issue.includes('缺一眼效果')));
 const withoutChecks=receipt(checkedSource,false);
 assert.throws(()=>validateTeachingBaselineReview(withoutChecks,checkedSource),/teaching_first_glance_checks_invalid/);
 const instructions=baselineInstructions(checkedSource,false,true,true);
 assert.match(instructions, /narration_checks，每个 narrationTargets 项恰好一条 \{[^}]*line_id\?,first_glance_checks:\{explanation,hook\?,hook_line_id\?\}\}/);
 assert.match(instructions, /fix 或 unresolved 也不能省略/);
 const selectionSource=teachingBaselineSource(withBrief,{...writingTask,stage:'blueprint'},[]);
 const preCopyInstructions=baselineInstructions(selectionSource,false,true,true);
 assert.match(preCopyInstructions,/比较对象如何建立.*可比参照.*首次应用.*后续结果/u);
 assert.match(preCopyInstructions,/在同一份 whole_film 回执集中列出/u);
 assert.doesNotMatch(instructions,/在同一份 whole_film 回执集中列出/u);
 assert.doesNotMatch(baselineInstructions(selectionSource),/在同一份 whole_film 回执集中列出/u,
  'the early selection prompt does not change stored review digests');
 const interrupted:ProductionTask={...writingTask,stage:'copy_review',status:'blocked',error:firstGlanceReceiptError,
  projectRevision:'revision-with-candidate',repairs:1,createdAt:Date.now(),
  completed:{blueprint:{artifact:{revision:'revision-with-candidate'},at:Date.now()}},
  effects:{['copy_review:initial:1:teaching-baseline:'+'a'.repeat(64)]:{kind:'model',operationId:'receipt',status:'failed',error:firstGlanceReceiptError}},
  feedbackUsed:false};
 assert(canResumeFirstGlanceReview(interrupted));
 assert.deepEqual(blockedProductionDecision(interrupted,1).routes,[],'the worker needs an explicit retry request');
 assert(!canResumeFirstGlanceReview({...interrupted,createdAt:Date.now()-interrupted.input.budget.maxElapsedMs}));
 assert(!canResumeFirstGlanceReview({...interrupted,repairs:4,technicalRecoveryEpochs:[1,2,3],
  effects:{['copy_review:initial:4:teaching-baseline:'+'a'.repeat(64)]:{kind:'model',operationId:'receipt',status:'failed',error:firstGlanceReceiptError}}}));
 assert(!canResumeFirstGlanceReview({...interrupted,projectRevision:'other-revision'}));
 assert(!canResumeFirstGlanceReview({...interrupted,error:'Error: upstream outcome unknown'}));
 assert(!canResumeFirstGlanceReview({...interrupted,repairs:2,effects:{...interrupted.effects,
  ['copy_review:initial:2:teaching-baseline:'+'a'.repeat(64)]:{kind:'model',operationId:'second',status:'failed',error:firstGlanceReceiptError}}}));
 const reviewed={...withoutChecks,narration_checks:withoutChecks.narration_checks.map(entry=>({...entry,
  first_glance_checks:entry.point_id==='hook'?{hook:'ok',hook_line_id:'hook',explanation:'ok'}:{explanation:'ok'},
 }))};
 const findings=validateTeachingBaselineReview(reviewed,checkedSource);
 assert.deepEqual(findings.narration_checks?.find(entry=>entry.point_id==='hook')?.first_glance_checks,
  {hook:'ok',hook_line_id:'hook',explanation:'ok'});
 for(const hook_line_id of [undefined,'palettes']){
  const unbound={...reviewed,narration_checks:reviewed.narration_checks.map(entry=>entry.point_id==='hook'
   ?{...entry,first_glance_checks:{...entry.first_glance_checks,hook_line_id}}:entry)};
  assert.throws(()=>validateTeachingBaselineReview(unbound,checkedSource),/teaching_first_glance_checks_invalid/);
 }
 const wrongHook={...reviewed,narration_checks:reviewed.narration_checks.map(entry=>entry.point_id==='hook'
  ?{...entry,first_glance_checks:{explanation:'ok',hook:'fix'}}:entry)};
 assert.throws(()=>validateTeachingBaselineReview(wrongHook,checkedSource),/teaching_first_glance_checks_invalid/);
 const enumerated={...reviewed,narration_checks:reviewed.narration_checks.map(entry=>entry.point_id==='nose'
  ?{...entry,first_glance_checks:{explanation:'fix'}}:entry)};
 assert.throws(()=>validateTeachingBaselineReview(enumerated,checkedSource),/teaching_first_glance_checks_invalid/);
 const optionalDetail={...reviewed,narration_checks:reviewed.narration_checks.map(entry=>entry.point_id==='nose'
  ?{...entry,status:'fix',reason:'建议在口播逐个念画面已交代的部位。',baseline_criterion:{field:'method',
   quote:checkedSource.units.find(unit=>unit.unit_id===entry.unit_id)!.points[0].teaching_basis!.method}}:entry)};
 assert.throws(()=>validateTeachingBaselineReview(optionalDetail,checkedSource),/teaching_first_glance_checks_invalid/);
 writingUnits[0].teaching_selection!.hook_curiosity!.point_id='nose';
 assert(teachingPointGaps(briefSource(),withBrief).some(issue=>issue.includes('本组主讲口播')));
 console.log('PASS first-glance brief is required and bound to the spoken group; hook and explanation receipts cannot be waived by overall pass');
 console.log('PASS full inventory, unselected interest, duplicate decision, timing disposal, two source-bound lines, and a quoted inference rejection');
 return {doc,reassurance,missingRole,inference};

 function taSource(project:ProjectDoc){return teachingBaselineSource(project,task,[]);}
}
