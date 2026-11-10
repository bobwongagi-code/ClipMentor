import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {ProjectDoc} from '../../src/editor/types';

/** Explicit local fake receipt; never calls a provider or certifies real production. */
export async function writeStoryboardFixtureReceipt(doc:ProjectDoc,directory:string,id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'){
 const analysis=doc.clipMentorAnalysis!,duration=analysis.source.duration_seconds;
 if(!analysis.evidence.some(e=>e.evidence_id==='storyboard-visible-fixture'))analysis.evidence.push({evidence_id:'storyboard-visible-fixture',kind:'visible_action',text:'A palette is held in front of the camera.',source_range_seconds:[0,duration],source_ids:[id],supporting_evidence_ids:[],status:'fixture',call_status:'succeeded',observation_method:'saved_source_video_model_receipt'});
 const evidence=analysis.evidence.filter(e=>e.kind==='original_claim'||e.kind==='visible_action');
 const original=JSON.stringify({projectId:'fixture'}),path=join(directory,'clipmentor-source-video');
 await mkdir(path,{recursive:true});
 await writeFile(join(path,id+'.json'),original);
 await writeFile(join(path,id+'.revalidated.json'),JSON.stringify({operationId:id,projectId:'fixture',source_hash:doc.clipMentorAnalysis!.source.sourceContentHash,
  revalidation:{version:'fixture',original_record_sha256:createHash('sha256').update(original).digest('hex'),requestsSent:0},
  result:{validation:{status:'valid'},actual_handoff_verified:false,complete_film_accepted:false,raw_observation:{windows:[{evidence:evidence.filter(e=>e.source_range_seconds).map(e=>({start_seconds:e.source_range_seconds![0],end_seconds:e.source_range_seconds![1],audible:e.kind==='original_claim'?e.text:'',visible:e.kind==='visible_action'?e.text:''}))}]}}}));
 evidence.forEach(e=>{e.source_ids=[id];});
 const claims=evidence.filter(e=>e.kind==='original_claim'&&e.source_range_seconds&&e.source_range_seconds[0]<duration&&e.source_range_seconds[1]>0);
 const sourceAsset=doc.assets.find(a=>a.id===analysis.source.asset_id)!;
 sourceAsset.props={...sourceAsset.props,clipmentorCreatorStoryboard:{source_sha256:analysis.source.sourceContentHash,rows:[{source_range_seconds:[0,duration],source_frames:[0],shot_ms:'Dia menunjukkan palet kepada kamera.',information_ms:'Dia menunjukkan warna pilihan dalam video asal.',visible_evidence_ids:['storyboard-visible-fixture'],claim_evidence_ids:claims.map(e=>e.evidence_id)}]}};
}
