import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visualDoneCriteria, type HandoffPolicy, type VisualDoneCriterion } from '../../shared/clipmentor-handoff';
import { digestValue } from '../agent-runs/store-values';
import { isSafeUploadName } from '../media-dir';
import { deliveryLayoutStages } from './delivery-layout-frames';
import type { DeliverySection } from '../../src/clipmentor/delivery-bindings';

type Section = Pick<DeliverySection,'section_id'|'picture'>;
export function boundVisualCriteria(policy:HandoffPolicy|null) {
 const criteria=policy?visualDoneCriteria(policy.brief.doneCriteria):[];
 if(!criteria.length)return;
 const entries=criteria.map(criterion=>{
  const asset=policy!.assetBindings.find(asset=>asset.id===criterion.reference.assetId);
  const src=asset?.src,sha=asset?.sourceContentHash;
  if(!asset||!['image','video'].includes(String(asset.kind))||typeof src!=='string'||!src.startsWith('/media/uploads/')
   ||!isSafeUploadName(src.slice('/media/uploads/'.length))||typeof sha!=='string'||!/^[a-f0-9]{64}$/.test(sha)
   ||(asset.kind==='image'&&criterion.reference.seconds!==0))throw Error('handoff_visual_reference_unbound:'+criterion.id);
  return {criterion,src,sha};
 });
 return {entries,digest:digestValue(entries)};
}
export type BoundVisualCriteria=NonNullable<ReturnType<typeof boundVisualCriteria>>;

export function assertVisualCriteriaPlan(bound:BoundVisualCriteria|undefined,sections:readonly Section[]|undefined) {
 for(const {criterion} of bound?.entries??[]){
  if(criterion.layout==='unrepresented'||!sections?.some(s=>s.section_id===criterion.sectionId&&s.picture.layout?.kind===criterion.layout
    &&(!criterion.pictureSha256||s.picture.sha256===criterion.pictureSha256)
    &&deliveryLayoutStages(s.picture).includes(criterion.pictureStage)))
   throw Error('handoff_visual_criterion_unresolved:'+criterion.id);
 }
}
export function visualCriteriaApproved(bound:BoundVisualCriteria,receipt:{verdict:string;visual_criteria_digest?:string;
 visual_criteria_checks?:Array<{id:string;answer:string;picture_stage:string}>}|undefined){
 return receipt?.verdict==='pass'&&receipt.visual_criteria_digest===bound.digest
  &&receipt.visual_criteria_checks?.length===bound.entries.length
  &&bound.entries.every(({criterion})=>receipt.visual_criteria_checks?.some(c=>c.id===criterion.id&&c.answer==='yes'&&c.picture_stage===criterion.pictureStage));
}

export type VisualReferenceFrame={criterion:VisualDoneCriterion;base64:string};
type FrameIO={resolve(name:string):string|null;hash(file:string):Promise<string>;frame(file:string,seconds:number,output:string):Promise<string>};
export async function visualReferenceFrames(bound:BoundVisualCriteria,io:FrameIO):Promise<VisualReferenceFrame[]>{
 const tmp=await mkdtemp(join(tmpdir(),'clipmentor-visual-reference-'));
 try{
  const frames:VisualReferenceFrame[]=[];
  const checked=new Map<string,string>();
  for(const [i,{criterion,src,sha}] of bound.entries.entries()){
   const file=io.resolve(src.slice('/media/uploads/'.length));
   if(!file||(checked.get(file)??await io.hash(file))!==sha)throw Error('handoff_visual_reference_changed:'+criterion.id);
   checked.set(file,sha);
   const base64=await io.frame(file,criterion.reference.seconds,join(tmp,i+'.jpg'));
   if(!base64||base64.length>1_500_000||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw Error('handoff_visual_reference_invalid:'+criterion.id);
   frames.push({criterion,base64});
  }
  for(const [file,sha] of checked)if(await io.hash(file)!==sha)throw Error('handoff_visual_reference_changed');
  return frames;
 }finally{await rm(tmp,{recursive:true,force:true});}
}
