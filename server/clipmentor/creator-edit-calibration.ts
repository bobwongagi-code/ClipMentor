import {contextReviewFrame,matchingContextLabel,translatedLineLabels} from './blueprint-review-board-human-context';
import {copyLineSourceBinding} from '../../src/clipmentor/source-breakdown';
import {readBlueprint} from '../../src/clipmentor/blueprint-lint';
import {stageCuePalette,stageCueTopStripProps} from '../../src/clipmentor/blueprint-picture-notices';
import type {ProjectDoc} from '../../src/editor/types';

type Row = Record<string,unknown>;
const record = (value:unknown):Row =>
  value && typeof value==='object' && !Array.isArray(value) ? value as Row : {};
const normalized = (value:unknown) => typeof value==='string' ? value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') : undefined;
const range = (value:unknown):[number,number]|undefined =>
  Array.isArray(value) && value.length===2 && value.every(Number.isFinite)
  && value[0]>=0 && value[1]>=value[0] ? [value[0],value[1]] : undefined;

type EditingFacts = { originalShare?:number; stillsPerGroup:number };
type Interval = { low:number; high:number; margin:number };
export type ApprovedEditingReference = {
  originalShare?: Interval;
  stillsPerGroup?: Interval;
};

// Keep the runtime reference empty until the editor approves measured anchor ranges.
// The local archive report is a proposal and is never read by the production worker.
export const approvedEditingReference: ApprovedEditingReference | undefined = undefined;

export function creatorEditingAdvisories(facts:EditingFacts | undefined, reference:ApprovedEditingReference | undefined) {
  if(!facts||!reference)return [];
  const outside = (value:number|undefined, interval:Interval|undefined) => {
    if(value===undefined||!interval||!Number.isFinite(value))return false;
    const {low,high,margin}=interval;
    return [low,high,margin].every(Number.isFinite)&&low>=0&&low<=high&&margin>0
      && (value<low-margin||value>high+margin);
  };
  return [
    ...(outside(facts.originalShare,reference.originalShare)&&reference.originalShare!.high<=1?[{
      question:'balance', level:'advice', originalShare:facts.originalShare,
      message:'原片计划时长占比明显偏离已确认的剪辑参考，请结合本片的教学任务判断。实际声长和成片比例留待执行核对。',
    }]:[]),
    ...(outside(facts.stillsPerGroup,reference.stillsPerGroup)?[{
      question:'picture_support', level:'advice', stillsPerGroup:facts.stillsPerGroup,
      message:'每组计划定格数明显偏离已确认的剪辑参考，请逐处核对定格有没有读图任务。',
    }]:[]),
  ];
}

export function creatorEditingFacts(doc:ProjectDoc) {
  const blueprint=readBlueprint(doc);
  const analysis=doc.clipMentorAnalysis, breakdown=analysis?.source_breakdown;
  const findings:{code:string;id:string;targets?:string[]}[]=[];
  let original=0, explanation=0, stillCount=0;
  let complete=blueprint.selectedPlans.length>0, directMotion=true;
  const groups=blueprint.selectedPlans.map(({unit,plan,resolved})=>{
    const unitId=String(unit.unit_id), operational=resolved?.operational??plan;
    const cues=record(operational.viewer_stage_cues), layout=record(cues.layout);
    const stages={original:stageCueTopStripProps(layout,'original'),explanation:stageCueTopStripProps(layout,'explanation')};
    const validStage=(['original','explanation'] as const).every(stage=>{
      const style=stages[stage], expected=stageCuePalette(undefined,stage);
      return style&&style.backgroundColor.toUpperCase()===expected.backgroundColor
        &&style.color.toUpperCase()===expected.color;
    });
    const detail=record(operational.composition).detail;
    let customStageLayout=false;
    if(typeof detail==='string')try{
      const parsed=record(JSON.parse(detail));
      customStageLayout=!!parsed.layout_spec||Array.isArray(parsed.production_rows);
    }catch{/* Prose is not an exact composition override. */}
    if(!validStage||customStageLayout)findings.push({code:'picture_plan_creator_stage_visual_invalid',id:unitId});
    const internal=record(unit.internal_review);
    const candidate=record(internal[String(internal.current_script_candidate)]);
    const lines=new Map((Array.isArray(candidate.lines)?candidate.lines:[]).map(record)
      .filter(line=>typeof line.id==='string').map(line=>[line.id,line] as const));
    const phaseTitles=new Set([record(cues.original).text,
      ...(Array.isArray(cues.revisit)?cues.revisit.map(cue=>record(cue).text):[])].map(normalized));
    const ledgerUnit=breakdown?.units.find(registered=>registered.unit_id===unitId);
    const phases=resolved?.phases??(Array.isArray(plan.phases)?plan.phases.map(record):[]);
    const stills:{lineId:string;at:number;frame:number;purpose:unknown;label?:string}[]=[];
    if(!phases.length||resolved?.issues.length)complete=false;
    for(const phase of phases){
      const source=range(phase.source_range_seconds??phase.source_seconds);
      if(!source||source[0]===source[1]){complete=false;continue;}
      if(phase.mode==='original'){original+=source[1]-source[0];continue;}
      if(phase.mode!=='explanation'){complete=false;continue;}
      explanation+=source[1]-source[0];
      const lineId=String(phase.line_id??''), line=lines.get(lineId);
      const captions=new Set([line?.narration_ms,...(Array.isArray(line?.caption_lines)?line.caption_lines:[])].map(normalized));
      const translated=translatedLineLabels(line??{});
      const labels=translated.invalid?[]:translated.pairs;
      const binding=breakdown&&ledgerUnit&&line?copyLineSourceBinding(breakdown,ledgerUnit,line,operational):undefined;
      const selectedContext=Array.isArray(phase.context_source_ranges)?phase.context_source_ranges.map(record):[];
      // A phase may be an envelope around multiple admitted windows. In that
      // case the envelope duration cannot estimate the amount actually shown.
      if(!binding||selectedContext.length||!binding.evidence_source_ranges.some(({source_range_seconds:[from,to]})=>source[0]>=from&&source[1]<=to))
        directMotion=false;
      const samples=selectedContext.flatMap(context=>{
        const sourceRange=range(context.source_range_seconds);
        if(!sourceRange||!analysis)return [];
        const tag=matchingContextLabel(labels,context.purpose);
        const frame=contextReviewFrame(sourceRange,analysis.source.fps,analysis.source.duration_seconds,!!tag);
        return frame===undefined?[]:[{context,sourceRange,tag,frame}];
      });
      const counts=new Map<number,number>();
      for(const {frame} of samples)counts.set(frame,(counts.get(frame)??0)+1);
      for(const {context,sourceRange:[from,to],tag,frame} of samples){
        if(from!==to)continue;
        const text=normalized(tag?.ms);
        const bound=binding?.context_source_ranges.some(item=>item.segment_id===context.segment_id
          &&item.source_range_seconds[0]===from&&item.source_range_seconds[1]===to&&item.purpose===context.purpose);
        const label=bound&&counts.get(frame)===1&&text&&!phaseTitles.has(text)&&!captions.has(text)?tag?.ms:undefined;
        stillCount++;
        stills.push({lineId,at:from,frame,purpose:context.purpose,...(label?{label}:{})});
        if(!label)findings.push({code:'picture_plan_creator_still_annotation_missing',id:unitId,
          targets:[`${lineId} / ${String(context.segment_id)} / 源帧 ${frame}`]});
      }
    }
    return {unit_id:unitId,stages,stills};
  });
  const facts:EditingFacts|undefined=complete?{
    ...(original>0&&explanation>0&&directMotion&&stillCount===0?{originalShare:original/(original+explanation)}:{}),
    stillsPerGroup:stillCount/blueprint.selectedPlans.length,
  }:undefined;
  return {findings, facts, groups};
}

export function creatorCopyTerminologyGaps(facts: readonly {unit_id:string;lines:readonly {id:string;narration:string}[]}[]) {
  return facts.flatMap(group => group.lines.flatMap(line =>
    /(?:^|[^\p{L}])pelanggan(?=$|[^\p{L}])/iu.test(line.narration.normalize('NFKC'))
      ? [{code:'creator_copy_buyer_term',id:group.unit_id,targets:[line.id]}] : []));
}
