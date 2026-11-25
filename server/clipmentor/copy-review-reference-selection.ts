import type {TeachingPacket} from '../../src/clipmentor/production-gate';
import {reviewRecord as row,reviewReferenceResolver} from './review-references';

type Row = Record<string,unknown>;
type Unit = TeachingPacket['units'][number];

function mapRows(value:unknown,fn:(entry:Row,index:number)=>unknown) {
 return Array.isArray(value)?value.map((entry,index)=>row(entry)?fn(entry,index):entry):value;
}

function words(text:string) {
 return [...text.matchAll(/\S+/gu)];
}

/** Opening clause picks refer to the ordered words in the actual saved narration. */
export function openingReferenceWords(packet:TeachingPacket) {
 return packet.delivery_sections?.filter(section=>section.kind==='performance_opening').map(section=>({
  section_id:section.section_id,ordered_words:words(section.line.narration_ms).map((entry,index)=>[index+1,entry[0]]),
 }));
}

function selectedSpan(text:string,span:unknown) {
 const tokens=words(text);
 if(!Array.isArray(span)||span.length!==2||!span.every(Number.isSafeInteger)
  ||span[0]<1||span[0]>span[1]||span[1]>tokens.length)return;
 const start=tokens[span[0]-1]!.index!,last=tokens[span[1]-1]!;
 return text.slice(start,last.index!+last[0].length);
}

export function selectedCopyReviewReferences(input:unknown,packet:TeachingPacket) {
 if(!row(input)||input.reference_protocol!=='selection-v1')return input;
 const resolver=reviewReferenceResolver();
 function fill(entry:Row,field:string,path:string,material:string,selected:unknown,value:string|undefined) {
  if(entry[field]!==undefined||value===undefined)resolver.missing(path+'.'+field,material,entry[field]??selected);
  return value;
 }
 function copyQuote(entry:Row,unit:Unit|undefined,path:string,field:'quote'|'text',pointId?:unknown) {
  const line=unit?.lines.find(line=>line.line_id===entry.line_id&&(pointId===undefined||line.point_ids.includes(String(pointId))));
  const channel=entry.channel??'narration';
  const value=channel==='narration'?line?.narration_ms:channel==='caption'?line?.caption_lines.join(' ')
   :channel==='label'&&typeof entry.label_index==='number'&&Number.isSafeInteger(entry.label_index)
    ?line?.labels[entry.label_index]:undefined;
  return {...entry,[field]:fill(entry,field,path,'current_unit_'+String(channel),entry.line_id,value)};
 }
 const cases=mapRows(input.cases,c=>({...c,units:mapRows(c.units,u=>{
  const unit=packet.units.find(entry=>entry.unit_id===u.unit_id),path='cases.units.'+String(u.unit_id);
  return {...u,points:mapRows(u.points,p=>{
   const point=unit?.points.find(entry=>entry.point_id===p.point_id),pointPath=path+'.points.'+String(p.point_id);
   const citation=row(p.source_quote)?p.source_quote:undefined;
   const evidence=packet.source_evidence.find(e=>e.evidence_id===citation?.evidence_id&&point?.teaching_basis?.evidence_ids.includes(e.evidence_id));
   const observation=evidence?.observation.match(/^\[(?:visible_action|original_claim); [^\]\r\n]+\] ([\s\S]+)$/u)?.[1];
   return {...p,quotes:mapRows(p.quotes,(q,i)=>copyQuote(q,unit,pointPath+'.quotes.'+i,'text',p.point_id)),
    ...(citation||point?.teaching_basis?{source_quote:{...citation,
     quote:fill(citation??{},'quote',pointPath+'.source_quote','evidence_selected_for_this_point',citation?.evidence_id,observation)}}:{})};
  })};
 })}));
 function groupChecks(group:Row,unit:Unit|undefined,path:string) {
  const L1=row(group.L1)?group.L1:undefined;
  return {...group,...(L1?{L1:{...L1,evidence:mapRows(L1.evidence,(ref,i)=>ref.kind==='copy'
    ?copyQuote(ref,unit,path+'.L1.evidence.'+i,'quote'):ref)}}:{}),
   source_relations:mapRows(group.source_relations,(relation,i)=>{
    const claim=row(relation.claim_impact)?relation.claim_impact:undefined;
    return claim?{...relation,claim_impact:{...claim,claims:mapRows(claim.claims,
     (entry,j)=>copyQuote(entry,unit,path+'.source_relations.'+i+'.claims.'+j,'quote'))}}:relation;
   })};
 }
 const copy_units=mapRows(input.copy_units,u=>{
  const unit=packet.units.find(entry=>entry.unit_id===u.unit_id),path='copy_units.'+String(u.unit_id);
  const groups=u.group_checks;
  return {...u,findings:mapRows(u.findings,(entry,i)=>copyQuote(entry,unit,path+'.findings.'+i,'quote')),
   group_checks:row(groups)?groupChecks(groups,unit,path+'.group_checks'):mapRows(groups,(entry,i)=>groupChecks(entry,unit,path+'.group_checks.'+i))};
 });
 const delivery_checks=mapRows(input.delivery_checks,r=>{
  const section=packet.delivery_sections?.find(section=>section.section_id===r.section_id);
  if(!row(r.opening_comparison)||r.opening_comparison.status!=='preserved')return r;
  const comparison={...r.opening_comparison};
  for(const role of ['same_product','outcome_question','invitation']){
   const span=comparison[role+'_words'];
   if(role==='invitation'&&span===undefined&&comparison.invitation_quote===undefined)continue;
   comparison[role+'_quote']=fill(comparison,role+'_quote','delivery_checks.'+String(r.section_id)+'.opening_comparison',
    'current_opening_narration',undefined,section&&selectedSpan(section.line.narration_ms,span));
  }
  return {...r,opening_comparison:comparison};
 });
 resolver.assert();
 return {...input,cases,copy_units,delivery_checks};
}
