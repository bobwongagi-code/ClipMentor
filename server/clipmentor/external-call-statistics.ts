/** Descriptive samples only. Missing/invalid observations are never zero durations. */
export function waitDistribution(samples:ReadonlyArray<number|null|undefined>){
 const values=samples.filter((v):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0).sort((a,b)=>a-b);
 const percentile=(p:number)=>values.length?values[Math.max(0,Math.ceil(values.length*p)-1)]:null;
 return {samples:samples.length,known:values.length,unknown:samples.length-values.length,p50_ms:percentile(.5),p95_ms:percentile(.95),max_ms:values.at(-1)??null,method:'nearest_rank' as const};
}
export interface HistoricalCallSample {
 id:string;kind:string;route:string;material?:string;cache:'cold'|'reused'|'not_applicable'|'unknown';
 request_wait_ms:number|null;preparation_ms:number|null;hard_ms:number|null;
 complete_model_response:boolean|null;wire_sha256?:string;
 repeat_assessment:'authorized_experiment'|'avoidable'|'unknown';
 evidence:{file:string;pointer:string;sha256:string};
}
/** Closed input inventory, not a scan claiming all historical provider traffic. */
export function historicalCallBaseline(input:HistoricalCallSample[]){
 const unique=new Map<string,HistoricalCallSample>();let excluded=0;
 for(const row of input){
  if(!row.id||!row.kind||!row.route||(row.material!==undefined&&(typeof row.material!=='string'||!row.material))||(row.wire_sha256!==undefined&&!/^[a-f0-9]{64}$/.test(row.wire_sha256))||!['cold','reused','not_applicable','unknown'].includes(row.cache)
   ||!['authorized_experiment','avoidable','unknown'].includes(row.repeat_assessment)
   ||![true,false,null].includes(row.complete_model_response)||!row.evidence?.file||typeof row.evidence.pointer!=='string'||(row.evidence.pointer!==''&&!row.evidence.pointer.startsWith('/'))||!/^[a-f0-9]{64}$/.test(row.evidence.sha256))throw Error('baseline_sample_invalid');
  for(const key of ['request_wait_ms','preparation_ms','hard_ms'] as const)if(row[key]!==null&&(typeof row[key]!=='number'||!Number.isFinite(row[key])||row[key]<0))throw Error('baseline_duration_invalid');
  const prior=unique.get(row.id);
  if(prior){const {evidence:_a,...a}=prior,{evidence:_b,...b}=row;if(JSON.stringify(a)!==JSON.stringify(b))throw Error('baseline_duplicate_conflict');excluded++;continue;}
  unique.set(row.id,row);
 }
 const rows=[...unique.values()],groups=new Map<string,HistoricalCallSample[]>();
 for(const row of rows){const key=JSON.stringify([row.kind,row.route,row.cache,row.material??'unknown']);const group=groups.get(key)??[];group.push(row);groups.set(key,group);}
 const wires=new Map<string,string[]>();for(const row of rows)if(row.wire_sha256){const group=wires.get(row.wire_sha256)??[];group.push(row.id);wires.set(row.wire_sha256,group);}
 const repeatGroups=[...wires].filter(([,ids])=>ids.length>1).map(([wire_sha256,ids])=>({wire_sha256,ids,extra_submissions:ids.length-1}));
 const unknown=rows.filter(r=>r.repeat_assessment==='unknown').length;
 return {sample_count:rows.length,duplicate_records_excluded:excluded,
  groups:[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([key,list])=>{
   const [kind,route,cache,material]=JSON.parse(key);const noResult=list.filter(r=>r.complete_model_response===false);
   const bounded=list.filter(r=>r.hard_ms!==null&&r.request_wait_ms!==null);
   return {kind,route,cache,material,samples:list.length,request_wait:waitDistribution(list.map(r=>r.request_wait_ms)),
    W_no_complete_model_response:waitDistribution(noResult.map(r=>r.request_wait_ms)),outcome_unknown:list.filter(r=>r.complete_model_response===null).length,
    preparation:waitDistribution(list.map(r=>r.preparation_ms)),
    hard_wait_check:{known:bounded.length,unknown:list.length-bounded.length,exceeded:bounded.length?bounded.filter(r=>r.request_wait_ms!>r.hard_ms!).length:null}};
  }),
  D:{avoidable_confirmed:rows.filter(r=>r.repeat_assessment==='avoidable').length,classification_unknown:unknown,
   authorized_experiment_samples:rows.filter(r=>r.repeat_assessment==='authorized_experiment').length,
   sample_zero_avoidable_supported:rows.length>0&&unknown===0&&rows.every(r=>r.repeat_assessment!=='avoidable'),
   observed_same_wire_extra_submissions:repeatGroups.reduce((n,g)=>n+g.extra_submissions,0),same_wire_groups:repeatGroups,
   note:'Same wire hash detects identical request bodies only. It neither proves avoidable waste nor detects all semantic repeats.'},
  notes:['HTTP/model return is not content approval. Post-return validation failures are not no-response waits.',
   'Cold/reused/unknown and request/preparation waits are separate. Percentiles describe this retained sample only.',
   'Missing hard deadlines cannot establish zero overruns. No new requests were issued to fill gaps.']};
}
