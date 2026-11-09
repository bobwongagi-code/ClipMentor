import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { ProjectDoc } from '../../src/editor/types';
import type { AgentContext } from '../../src/agent/context';
import { isCopyReviewFailure, type CopyReviewRequest } from '../../shared/clipmentor-copy-review';
import viewerChainResponse from '../../src/clipmentor/fixtures/viewer-chain-raw-review-20261029.json';
import { makeDraft, replayActions } from '../../src/editor/store';
import { executeTool } from '../../src/agent/tools';
import { projectServerRunToolResult } from '../../src/agent/serverRunToolResult';
import { copyReviewSubject, copyTeachingPacketFromDoc, checkCopyProduction, normalizeGroupReview } from '../../src/clipmentor/production-gate';
import groupedProject from '../../src/clipmentor/fixtures/grouped-registration-v1.json';
import groupedRawResponse from '../../src/clipmentor/fixtures/four-group-raw-review-20261028.json';
import { CopyReviewError, reviewClipMentorCopy, revalidateStoredCopyReview, runIsolatedCodexReview, type CopyReviewDependencies } from './copy-review';
import { ToolFailureTracker, isFailedToolResult, structuredToolFailure } from '../../src/agent/toolFailure';
import sharp from 'sharp';
import type {BoundVisualCriteria} from './visual-done-criteria';

export async function verifyGroupedReviewReceipts({root,deps,base,request,goodRaw}:{root:string;deps:CopyReviewDependencies;base:ProjectDoc;request:()=>Promise<CopyReviewRequest>;goodRaw:()=>any}){
  const chainDeps = {...deps, frame:async()=> 'aGVsbG8='};
  // Real returned list must use the normal receipt boundary; never rewrite its raw verdict.
  {
    const original = JSON.stringify(viewerChainResponse);
    const realRequest = viewerChainResponse.request as unknown as CopyReviewRequest;
    const hashByName = new Map([[realRequest.source.src.split('/').at(-1)!, realRequest.source.hash]]);
    for (const section of realRequest.packet.delivery_sections ?? []) {
      hashByName.set(section.picture.src.split('/').at(-1)!, section.picture.sha256);
      const audio = section.voice.existing_audio;
      if (audio) hashByName.set(audio.src.split('/').at(-1)!, audio.sha256);
    }
    let fakeCalls = 0;
    const realDeps: CopyReviewDependencies = { directory: root, resolve: name => name,
      hash: async file => { assert(hashByName.has(file)); return hashByName.get(file)!; },
      frame: async () => 'aGVsbG8=', run: async () => { fakeCalls++; return structuredClone(viewerChainResponse.raw_review); } };
    const req = {...realRequest,operationId:randomUUID()};
    const result = await reviewClipMentorCopy(req,realDeps);
    assert.equal(result.receipt.verdict,'pass','the complete saved real response is valid after lossless viewer-chain normalization');
    assert.equal(result.receipt.units[0].group_checks!.L2.viewer_chain,viewerChainResponse.raw_review.copy_units[0].group_checks.L2.viewer_chain.join('\n'));
    const ledgerPath=join(root,req.operationId+'.json');
    const ledger=JSON.parse(await readFile(ledgerPath,'utf8'));
    assert.deepEqual(ledger.raw_review,viewerChainResponse.raw_review);
    assert.deepEqual(result.receipt.delivery_checks,viewerChainResponse.raw_review.delivery_checks);
    assert.deepEqual(await reviewClipMentorCopy(req,realDeps,undefined,true),{...result,cached:true});assert.equal(fakeCalls,1);
    // Revalidation is separately host-authorized, writes a sidecar in this temp test only,
    // and must leave a failed ledger + original consumed attempt untouched.
    const failed={...ledger,status:'failed',result:undefined,error:'response_receipt_invalid',
      diagnostic:{code:'response_receipt_invalid',stage:'response_validation',operationId:req.operationId,requestsAttempted:1,retryable:false}};
    const failedBytes=JSON.stringify(failed);await writeFile(ledgerPath,failedBytes);
    const neverRun={...realDeps,frame:async()=>{throw Error('no extraction during revalidation');},run:async()=>{throw Error('no provider during revalidation');}};
    const recovered=await revalidateStoredCopyReview(req,neverRun,{method:'saved-review-response-contract-v1',
      originalLedgerSha256:createHash('sha256').update(failedBytes).digest('hex'),actor:'test-only-explicit-host'});
    assert.equal(recovered.receipt.verdict,'pass');assert.equal(recovered.requestsAttempted,1);
    assert.equal(await readFile(ledgerPath,'utf8'),failedBytes);
    await assert.rejects(reviewClipMentorCopy(req,neverRun,undefined,true),/response_receipt_invalid/);
    assert.equal(fakeCalls,1);assert.equal(JSON.stringify(viewerChainResponse),original);
    const visualRequest=structuredClone(realRequest);
    const section=visualRequest.packet.delivery_sections!.find(s=>s.kind==='creator_invitation')!;
    const raw=structuredClone(viewerChainResponse.raw_review);
    const check=raw.delivery_checks.find(c=>c.section_id===section.section_id)!;
    check.section_id=section.section_id='new_contact';
    const poster=join(root,'criterion-poster.jpg');
    await sharp({create:{width:200,height:400,channels:3,background:'#669955'}}).jpeg().toFile(poster);
    section.picture.src='/media/uploads/criterion-poster.jpg';
    section.picture.sha256=createHash('sha256').update(await readFile(poster)).digest('hex');
    const old=structuredClone(visualRequest);
    delete section.picture.crop;
    section.picture.layout={kind:'product_commission',product_crop:{left:0,top:0,right:0,bottom:.55},
      commission_crop:{left:0,top:.65,right:0,bottom:0}};
    const criterion={id:'cta',quote:'  原始要求：同一屏要有商品和 11%。\n  ',question:'是否同屏？',sectionId:'new_contact',
      pictureStage:'商品与佣金同屏',layout:'product_commission' as const,reference:{assetId:'reference',fileName:'NIUMO V7.mp4',seconds:14}};
    const criteria:BoundVisualCriteria={digest:'1'.repeat(64),entries:[{criterion,src:section.picture.src,sha:section.picture.sha256}]};
    const visualDeps={...realDeps,resolve:(name:string)=>name==='criterion-poster.jpg'?poster:name,
      hash:async(file:string)=>file===poster?section.picture.sha256:realDeps.hash(file),
      visualCriteria:async()=>criteria};
    await assert.rejects(reviewClipMentorCopy({...old,operationId:randomUUID()},visualDeps),/criterion_unresolved:cta/);
    const {visualCriteriaPlanReceiptMatches}=await import('./visual-done-criteria'),{digestValue}=await import('../agent-runs/store-values');
    const nativeEntry:BoundVisualCriteria['entries'][number]={...criteria.entries[0],criterion:{...criterion,id:'native-label',sectionId:visualRequest.packet.units[0].unit_id,layout:'native_composition',pictureStage:'原片',quote:'沿用原片标识。',question:'实际原片标识是否沿用？'}};
    for(const [mixed,answer,expected]of [[false,'yes','pass'],[true,'yes','pass'],[true,'no','needs_revision']]as const){
     const entries=mixed?[nativeEntry,criteria.entries[0]]:[nativeEntry],bound={entries,digest:digestValue(entries)},req={...visualRequest,operationId:randomUUID()};let fakeRuns=0;
     const wireDeps={...visualDeps,visualCriteria:async()=>bound,run:async()=>{fakeRuns++;return {...structuredClone(raw),...(mixed?{visual_criteria_checks:[{id:criterion.id,answer,picture_stage:criterion.pictureStage,observation:'本方案合成画面的实际观察。'}]}:{})};}};
     const observed=await reviewClipMentorCopy(req,wireDeps);
     assert(visualCriteriaPlanReceiptMatches(bound,observed.receipt),'real saved receipt must pass the worker binding, including native-only and mixed');
     assert.equal(visualCriteriaPlanReceiptMatches(bound,{...observed.receipt,visual_criteria_digest:'f'.repeat(64)}),false);
     assert.equal(visualCriteriaPlanReceiptMatches(bound,undefined),false);
     assert.equal(observed.receipt.verdict,expected,'negative verdict remains a content repair, never an approval');
     assert.deepEqual((await reviewClipMentorCopy(req,wireDeps,undefined,true)).receipt,observed.receipt);assert.equal(fakeRuns,1);
    }

    for(const [answer,picture_stage,expected] of [
      ['yes',criterion.pictureStage,'pass'],['no',criterion.pictureStage,'needs_revision'],
      ['yes','参照图','insufficient_evidence'],['unknown',criterion.pictureStage,'insufficient_evidence'],
    ] as const){
      const stagedRequest={...visualRequest,operationId:randomUUID()};
      const stagedDeps={...visualDeps,run:async(prompt:string,frames:Parameters<CopyReviewDependencies['run']>[1])=>{
        assert(prompt.includes(JSON.stringify(criterion.quote)));
        assert(frames.some(f=>f.phase==='reference'&&f.source_seconds===14));
        assert(frames.some(f=>f.unit_id==='new_contact'&&f.delivery_view==='planned_composition'));
        return {...raw,visual_criteria_checks:[{id:'cta',answer,picture_stage,observation:'画面核对样本'}]};
      }};
      const observed=await reviewClipMentorCopy(stagedRequest,stagedDeps);
      assert.equal(observed.receipt.verdict,expected);
      assert.equal(observed.receipt.visual_criteria_digest,criteria.digest);
      if(answer==='no'){
        const file=join(root,stagedRequest.operationId+'.json'),ledger=JSON.parse(await readFile(file,'utf8'));
        const failed={...ledger,status:'failed',result:undefined,error:'response_receipt_invalid',diagnostic:{code:'response_receipt_invalid',stage:'response_validation',operationId:stagedRequest.operationId,requestsAttempted:1,retryable:false}};
        const bytes=JSON.stringify(failed);await writeFile(file,bytes);
        const noCalls={...stagedDeps,frame:async()=>{throw Error('must not extract');},run:async()=>{throw Error('must not call provider');}};
        const recovered=await revalidateStoredCopyReview(stagedRequest,noCalls,{method:'saved-review-response-contract-v1',originalLedgerSha256:createHash('sha256').update(bytes).digest('hex'),actor:'test-only-host'});
        assert.equal(recovered.receipt.verdict,'needs_revision');assert.equal(recovered.receipt.visual_criteria_digest,criteria.digest);
        assert.equal(recovered.receipt.visual_criteria_checks![0].answer,'no');assert.equal(await readFile(file,'utf8'),bytes);
        await assert.rejects(revalidateStoredCopyReview(stagedRequest,{...noCalls,visualCriteria:async()=>({...criteria,entries:[{...criteria.entries[0],criterion:{...criterion,quote:'Changed original requirement'}}]})},{method:'saved-review-response-contract-v1',originalLedgerSha256:createHash('sha256').update(bytes).digest('hex'),actor:'test-only-host'}),/revalidation_original_unavailable/);
      }

      if(expected==='pass'){
        const changed={...stagedDeps,visualCriteria:async()=>({...criteria,digest:'2'.repeat(64)})};
        await assert.rejects(reviewClipMentorCopy(stagedRequest,changed),/operation_unavailable/);
        assert.deepEqual((await reviewClipMentorCopy(stagedRequest,changed,undefined,true)).receipt,observed.receipt);
      }
    }
    const wrongRef={...criteria,entries:[{...criteria.entries[0],sha:'9'.repeat(64)}]};
    await assert.rejects(reviewClipMentorCopy({...visualRequest,operationId:randomUUID()},{...visualDeps,
      visualCriteria:async()=>wrongRef,run:async()=>{throw Error('unexpected call');}}),
      e=>e instanceof CopyReviewError&&e.diagnostic.requestsAttempted===0);
  }
  // Unit-level lists, group-level lists and persisted group_reviews share the same
  // conversion. Verdicts, source gaps and missing fields cannot be repaired by it.
  for (const chain of ['Original then explanation',['Original','Explanation'],['Same','Same']] as const) {
    const raw:any=goodRaw();raw.copy_units[0].group_checks.L2.viewer_chain=chain;
    const before=JSON.stringify(raw),req=await request();
    const result=await reviewClipMentorCopy(req,{...chainDeps,run:async()=>raw});
    assert.equal(result.receipt.verdict,'pass');assert.equal(JSON.stringify(raw),before);
    assert.equal(result.receipt.units[0].group_checks!.L2.viewer_chain,Array.isArray(chain)?chain.join('\n'):chain);
    const draft=makeDraft(structuredClone(base)),ctx:AgentContext={...draft,getCreativeMode:()=> 'clipmentor',getProjectId:()=>req.projectId,
      getAgentRunId:()=>req.authorRunId,templates:[],audio:[],hostFetch:async()=>Response.json(result)};
    const bound:any=await executeTool('request_clipmentor_copy_review',{operationId:req.operationId,maxRequests:1,expectedRevision:req.subject.revision},ctx);
    assert(bound.ok&&bound.production_gate.allowed);
    const read:any=await executeTool('read_clipmentor_analysis',{view:'copy_review',reviewPart:'result'},ctx);
    assert.deepEqual(read.analysis.copy_review.receipt.units[0].group_checks,result.receipt.units[0].group_checks);
    assert((await checkCopyProduction(JSON.parse(JSON.stringify(draft.getDoc())),'clipmentor')).allowed);
  }
  for(const [name,change,expected] of [
    ['L1 failed',(v:any)=>{v.copy_units[0].group_checks.L1.verdict='needs_revision';},'needs_revision'],
    ['L2 uncertain',(v:any)=>{v.copy_units[0].group_checks.L2.verdict='insufficient_evidence';},'insufficient_evidence'],
    ['source gap',(v:any)=>{v.copy_units[0].group_checks.source_relations[0].assessment='material_gap';},'needs_revision'],
    ['unknown source',(v:any)=>{v.copy_units[0].group_checks.source_relations[0].assessment='uncertain';},'insufficient_evidence'],
  ] as const){
    const raw:any=goodRaw();raw.copy_units[0].group_checks.L2.viewer_chain=['Original','Explanation'];change(raw);
    const result=await reviewClipMentorCopy(await request(),{...chainDeps,run:async()=>raw});assert.equal(result.receipt.verdict,expected,name);
  }
  for(const invalid of [[],[''],['Original',' '],['Original',3],['Original',{}],[['Original']],null,9,{},undefined]){
    const req=await request(),raw:any=goodRaw();raw.copy_units[0].group_checks.L2.viewer_chain=invalid;
    let attempts=0;const mock={...chainDeps,run:async()=>{attempts++;return raw;}};
    await assert.rejects(reviewClipMentorCopy(req,mock),(e:unknown)=>{
      assert(e instanceof CopyReviewError);assert(isCopyReviewFailure(e.diagnostic));
      assert.equal(e.diagnostic.code,'response_receipt_invalid');
      assert.deepEqual((e.diagnostic as any).responseContract,{field:'group_checks.L2.viewer_chain',unitIndex:0,reason:'expected_nonempty_text_or_text_list'});
      return true;
    });
    const failed=JSON.parse(await readFile(join(root,req.operationId+'.json'),'utf8'));
    assert.equal(failed.requests_attempted,1);assert.deepEqual(failed.raw_review,JSON.parse(JSON.stringify(raw)));
    await assert.rejects(reviewClipMentorCopy(req,mock,undefined,true));assert.equal(attempts,1,'invalid lists cannot trigger a retry');
    const envelope={error:'Invalid viewer chain',operationId:req.operationId,diagnostic:failed.diagnostic,requestsAttempted:1,production_approved:false};
    assert.deepEqual(structuredToolFailure(envelope),envelope,'closed field diagnostic survives the ordinary failure bridge');
    for(const bad of [{...failed.diagnostic.responseContract,private_path:'/private'},
      {...failed.diagnostic.responseContract,unitIndex:-1},{...failed.diagnostic.responseContract,groupIndex:0.5},
      {...failed.diagnostic.responseContract,field:'arbitrary private model output'},{...failed.diagnostic.responseContract,reason:'provider secret'}]){
      assert.equal(isCopyReviewFailure({...failed.diagnostic,responseContract:bad}),false);
    }
  }
  // Replay the complete real response in a disposable service ledger. The old
  // consumed operation and its failed production project must never be rewritten.
  const groupDoc = structuredClone(groupedProject) as unknown as ProjectDoc;
  const groupSubject = await copyReviewSubject(groupDoc);
  const groupPacket = await copyTeachingPacketFromDoc(groupDoc);
  const groupRequest = (): CopyReviewRequest => ({ operationId: randomUUID(), maxRequests: 1,
    projectId: 'grouped-test-project', authorRunId: 'host-author-run',
    source: { src: groupDoc.assets[0].src, hash: groupDoc.clipMentorAnalysis!.source.sourceContentHash!, fps: 30,
      duration: groupDoc.clipMentorAnalysis!.source.duration_seconds },
    subject: { revision: groupSubject.revision, digest: groupSubject.digest,
      units: groupSubject.units.map(({unit_id,candidate_id}) => ({unit_id,candidate_id})) }, packet: groupPacket });
  for (const container of ['groups','unit_group_reviews'] as const) {
    const raw:any=structuredClone(groupedRawResponse);
    raw.copy_units[0].group_checks.forEach((g:any)=>{g.L2.viewer_chain=[g.L2.viewer_chain,'Ordered final cue'];});
    const expected=raw.copy_units[0].group_checks.map((g:any)=>({...g,L2:{...g.L2,viewer_chain:g.L2.viewer_chain.join('\n')}}));
    if(container==='unit_group_reviews'){
      const aggregate:any=normalizeGroupReview(expected,groupPacket.units[0]);
      aggregate.L2.viewer_chain=[aggregate.L2.viewer_chain];aggregate.group_reviews=raw.copy_units[0].group_checks;
      raw.copy_units[0].group_checks=aggregate;
    }
    const before=JSON.stringify(raw);
    const result=await reviewClipMentorCopy(groupRequest(),{...chainDeps,resolve:()=> 'offline-group-source',
      hash:async()=>groupDoc.clipMentorAnalysis!.source.sourceContentHash!,run:async()=>raw});
    assert.equal(result.receipt.verdict,'pass',container);
    assert.deepEqual(result.receipt.units[0].group_checks!.group_reviews,expected);
    assert.equal(JSON.stringify(raw),before,'nested list conversion never mutates reviewer output');
    for(const broken of [[],['kept',4]]){
      const invalid:any=structuredClone(raw),group=container==='groups'?invalid.copy_units[0].group_checks[2]:invalid.copy_units[0].group_checks.group_reviews[2];
      group.L2.viewer_chain=broken;
      await assert.rejects(reviewClipMentorCopy(groupRequest(),{...chainDeps,resolve:()=> 'offline-group-source',
        hash:async()=>groupDoc.clipMentorAnalysis!.source.sourceContentHash!,run:async()=>invalid}),
        (e:unknown)=>e instanceof CopyReviewError && (e.diagnostic as any).responseContract?.groupIndex===2);
    }
  }
  const rawGroups = JSON.stringify(groupedRawResponse);
  let groupCalls = 0;
  const groupDeps: CopyReviewDependencies = { ...deps, resolve: () => 'offline-group-source',
    hash: async () => groupDoc.clipMentorAnalysis!.source.sourceContentHash!,
    frame: async () => Buffer.from('offline-group-frame').toString('base64'),
    run: async () => { groupCalls++; return structuredClone(groupedRawResponse); } };
  const groupReq = groupRequest();
  const groupResult = await reviewClipMentorCopy(groupReq, groupDeps);
  assert.equal(groupResult.receipt.verdict, 'pass', 'complete four-group response must cross the ordinary production receipt contract');
  const preserved = (groupResult.receipt.units[0].group_checks as any).group_reviews;
  assert.deepEqual(preserved, groupedRawResponse.copy_units[0].group_checks, 'every original group judgment and reason survives');
  const groupLedger = JSON.parse(await readFile(join(root, groupReq.operationId + '.json'), 'utf8'));
  assert.deepEqual(groupLedger.raw_review, groupedRawResponse);

  // A consumed format failure can only be recovered by an explicit host action.
  {
    const hash = (v: string) => createHash('sha256').update(v).digest('hex');
    const failedRequest = groupRequest();
    const failedLedgerPath = join(root, failedRequest.operationId + '.json');
    const failed = {...groupLedger, status:'failed', result:undefined,
      fingerprint:hash('isolated-codex-copy-and-picture-v1' + JSON.stringify(failedRequest)),
      diagnostic:{code:'response_receipt_invalid',stage:'response_validation',operationId:failedRequest.operationId,requestsAttempted:1,retryable:false},
      error:'response_receipt_invalid'};
    const original = JSON.stringify(failed);
    await writeFile(failedLedgerPath, original);
    const noCalls = {...groupDeps,
      frame:async()=>{throw Error('saved response recovery must not extract frames');},
      run:async()=>{throw Error('saved response recovery must not call a model');}};
    const annotation = {method:'saved-review-response-contract-v1' as const,
      originalLedgerSha256:hash(original),actor:'explicitly-authorized-host'};
    await assert.rejects(reviewClipMentorCopy(failedRequest,noCalls,undefined,true),
      (e:unknown)=>e instanceof CopyReviewError && e.diagnostic.code==='response_receipt_invalid');
    const recovered = await revalidateStoredCopyReview(failedRequest,noCalls,annotation);
    assert.equal(recovered.receipt.verdict,'pass');assert.equal(recovered.requestsAttempted,1);assert(recovered.cached);
    assert.deepEqual(recovered.receipt.units[0].group_checks!.group_reviews,groupedRawResponse.copy_units[0].group_checks);
    assert.deepEqual(await revalidateStoredCopyReview(failedRequest,noCalls,annotation),recovered,'host recovery is idempotent');
    assert.equal(await readFile(failedLedgerPath,'utf8'),original,'original failure and attempt count are immutable');
    await assert.rejects(reviewClipMentorCopy(failedRequest,noCalls,undefined,true),
      (e:unknown)=>e instanceof CopyReviewError && e.diagnostic.code==='response_receipt_invalid','ordinary historical read keeps the original failure');
    await assert.rejects(revalidateStoredCopyReview(failedRequest,noCalls,{...annotation,originalLedgerSha256:'0'.repeat(64)}),/binding_invalid/);
    await assert.rejects(revalidateStoredCopyReview({...failedRequest,projectId:'other'},noCalls,annotation),/original_unavailable/);
    await assert.rejects(revalidateStoredCopyReview(failedRequest,{...noCalls,hash:async()=> '0'.repeat(64)},annotation),/source_changed/);
    const recoveryPath=join(root,failedRequest.operationId+'.revalidated-response-contract-v1.json');
    const recoveryBytes=await readFile(recoveryPath,'utf8'),editedRecovery=JSON.parse(recoveryBytes);
    editedRecovery.result.receipt.units[0].group_checks.group_reviews[0].L1.reason='Forged replacement';
    await writeFile(recoveryPath,JSON.stringify(editedRecovery));
    await assert.rejects(revalidateStoredCopyReview(failedRequest,noCalls,annotation),/record_invalid/,'do not trust a cached approval');
    await writeFile(recoveryPath,recoveryBytes);
    for (const [field,value] of [['prompt_sha256','0'.repeat(64)],['requests_attempted',0],['raw_review',null]] as const) {
      const changed={...failed,[field]:value}, bytes=JSON.stringify(changed);
      await writeFile(failedLedgerPath,bytes);
      await assert.rejects(revalidateStoredCopyReview(failedRequest,noCalls,{...annotation,originalLedgerSha256:hash(bytes)}),/original_unavailable/);
    }
    const providerFailure={...failed,diagnostic:{...failed.diagnostic,code:'model_turn_failed',stage:'model_turn'}};
    const providerFailureBytes=JSON.stringify(providerFailure);await writeFile(failedLedgerPath,providerFailureBytes);
    await assert.rejects(revalidateStoredCopyReview(failedRequest,noCalls,{...annotation,originalLedgerSha256:hash(providerFailureBytes)}),/original_unavailable/,'transport failures cannot be converted into approval');
    await writeFile(failedLedgerPath,original);
    const recoveredDoc=structuredClone(groupDoc);
    recoveredDoc.clipMentorAnalysis!.production_copy_review=recovered.receipt;
    assert((await checkCopyProduction(recoveredDoc,'clipmentor')).allowed);
    recoveredDoc.clipMentorAnalysis!.revision++;
    assert(!(await checkCopyProduction(recoveredDoc,'clipmentor')).allowed,'recovery does not authorize another revision');
    for(const [name,change,expected] of [
      ['missing group',(v:any)=>{v.copy_units[0].group_checks.pop();},'invalid'],
      ['failed group',(v:any)=>{v.copy_units[0].group_checks[0].L1.verdict='needs_revision';},'needs_revision'],
      ['unknown group',(v:any)=>{v.copy_units[0].group_checks[0].L2.verdict='insufficient_evidence';},'insufficient_evidence'],
    ] as const){
      const req=groupRequest(), raw:any=structuredClone(groupedRawResponse);change(raw);
      const record={...failed,fingerprint:hash('isolated-codex-copy-and-picture-v1'+JSON.stringify(req)),raw_review:raw,
        diagnostic:{...failed.diagnostic,operationId:req.operationId}};
      const bytes=JSON.stringify(record),path=join(root,req.operationId+'.json');await writeFile(path,bytes);
      const auth={...annotation,originalLedgerSha256:hash(bytes)};
      if(expected==='invalid') await assert.rejects(revalidateStoredCopyReview(req,noCalls,auth),/receipt_invalid/);
      else {
        const result=await revalidateStoredCopyReview(req,noCalls,auth);assert.equal(result.receipt.verdict,expected,name);
        const doc=structuredClone(groupDoc);doc.clipMentorAnalysis!.production_copy_review=result.receipt;
        assert(!(await checkCopyProduction(doc,'clipmentor')).allowed,name+' must not grant production');
      }
      assert.equal(await readFile(path,'utf8'),bytes);
    }
  }

  assert.equal(JSON.stringify(groupedRawResponse), rawGroups, 'normalization cannot mutate the model response');
  const reversedGroups = structuredClone(groupedRawResponse.copy_units[0].group_checks).reverse();
  const reversedView: any = normalizeGroupReview(reversedGroups,groupPacket.units[0]);
  assert.deepEqual(reversedView.group_reviews,reversedGroups,'explicit IDs bind results without rewriting the raw ordering');
  assert(reversedView.L1.learner_takeaway.startsWith('G1:'),'the derived unit view follows actual playback order');
  const twoGroupUnit = structuredClone(groupPacket.units[0]);
  twoGroupUnit.lines=twoGroupUnit.lines.slice(0,2);
  twoGroupUnit.picture_plan!.execution_plan!.content.phases=(twoGroupUnit.picture_plan!.execution_plan!.content.phases as any[]).slice(0,4);
  assert.equal((normalizeGroupReview(groupedRawResponse.copy_units[0].group_checks.slice(0,2),twoGroupUnit) as any).group_reviews.length,2,'group count comes from the plan, never a Barely There-specific constant');
  const originalUnitObject: any=structuredClone(groupResult.receipt.units[0].group_checks);delete originalUnitObject.group_reviews;
  assert.deepEqual(normalizeGroupReview(originalUnitObject,groupPacket.units[0]),originalUnitObject,'existing complete unit-level responses stay valid');
  assert.deepEqual(await reviewClipMentorCopy(groupReq, groupDeps, undefined, true), {...groupResult,cached:true});
  assert.equal(groupCalls, 1, 'saved receipt reread must not invoke even the fake reviewer again');
  const groupDraft = makeDraft(structuredClone(groupDoc));
  const groupCtx: AgentContext = {...groupDraft,getCreativeMode:()=> 'clipmentor',getProjectId:()=>groupReq.projectId,
    getAgentRunId:()=>groupReq.authorRunId,templates:[],audio:[],hostFetch:async()=>Response.json(groupResult)};
  const groupTool: any = await executeTool('request_clipmentor_copy_review', {operationId:groupReq.operationId,maxRequests:1,expectedRevision:groupSubject.revision}, groupCtx);
  assert(groupTool.ok && groupTool.production_gate.allowed, 'the normal tool binds a valid service receipt');
  const groupRead: any = await executeTool('read_clipmentor_analysis', {view:'copy_review'}, groupCtx);
  assert.deepEqual(groupRead.analysis.copy_review.receipt.units[0].group_checks.group_reviews, preserved);
  const transported: any = projectServerRunToolResult(JSON.parse(JSON.stringify(groupRead)));
  assert.deepEqual(transported.analysis.copy_review.receipt.units[0].group_checks.group_reviews,preserved,'all group details survive the ordinary browser/server readback boundary');
  const coldGroup = JSON.parse(JSON.stringify(groupDraft.getDoc())) as ProjectDoc;
  assert((await checkCopyProduction(coldGroup, 'clipmentor')).allowed, 'serialized readback keeps complete group coverage');
  const tampered = structuredClone(coldGroup);
  (tampered.clipMentorAnalysis!.production_copy_review!.units[0].group_checks as any).group_reviews[3].L2.verdict = 'insufficient_evidence';
  assert(!(await checkCopyProduction(tampered, 'clipmentor')).allowed, 'a passing aggregate cannot hide a failing saved subgroup');
  const missingSavedGroup=structuredClone(coldGroup);
  (missingSavedGroup.clipMentorAnalysis!.production_copy_review!.units[0].group_checks as any).group_reviews.pop();
  assert(!(await checkCopyProduction(missingSavedGroup,'clipmentor')).allowed,'a valid-looking aggregate cannot cover a missing persisted group');
  for (const [name, change, expected] of [
    ['L1 failed', (v:any)=>{v.copy_units[0].group_checks[0].L1.verdict='needs_revision';}, 'needs_revision'],
    ['L2 unknown', (v:any)=>{v.copy_units[0].group_checks[3].L2.verdict='insufficient_evidence';}, 'insufficient_evidence'],
    ['group verdict failed', (v:any)=>{v.copy_units[0].group_checks[2].verdict='needs_revision';}, 'needs_revision'],
    ['unresolved source', (v:any)=>{delete v.copy_units[0].group_checks[3].source_relations.at(-1).claim_impact;}, 'insufficient_evidence'],
    ['source gap', (v:any)=>{v.copy_units[0].group_checks[3].source_relations[0].assessment='material_gap';}, 'needs_revision'],
  ] as const) {
    const raw: any = structuredClone(groupedRawResponse); change(raw);
    const req = groupRequest(); let attempts = 0;
    const mock = {...groupDeps,run:async()=>{attempts++;return raw;}};
    const result = await reviewClipMentorCopy(req,mock);
    assert.equal(result.receipt.verdict,expected,name);
    assert.deepEqual((result.receipt.units[0].group_checks as any).group_reviews,raw.copy_units[0].group_checks);
    const ledger = JSON.parse(await readFile(join(root,req.operationId+'.json'),'utf8'));
    assert.deepEqual(ledger.raw_review,raw,name+' retains the original judgment');
    assert.deepEqual(await reviewClipMentorCopy(req,mock,undefined,true),{...result,cached:true});assert.equal(attempts,1);
    const draft = makeDraft(structuredClone(groupDoc));
    const ctx: AgentContext = {...draft,getCreativeMode:()=> 'clipmentor',getProjectId:()=>req.projectId,getAgentRunId:()=>req.authorRunId,
      templates:[],audio:[],hostFetch:async()=>Response.json(result)};
    const rejected: any = await executeTool('request_clipmentor_copy_review',{operationId:req.operationId,maxRequests:1,expectedRevision:groupSubject.revision},ctx);
    assert(rejected.ok && !rejected.production_gate.allowed,name+' is saved without release');
  }
  for (const [name,change] of [
    ['empty groups',(v:any)=>{v.copy_units[0].group_checks=[];}],
    ['missing group',(v:any)=>{v.copy_units[0].group_checks.pop();}],
    ['duplicate group',(v:any)=>{v.copy_units[0].group_checks[3].group_id='G3';}],
    ['unknown group',(v:any)=>{v.copy_units[0].group_checks[3].group_id='G5';}],
    ['missing ID',(v:any)=>{delete v.copy_units[0].group_checks[1].group_id;}],
    ['missing L2',(v:any)=>{delete v.copy_units[0].group_checks[1].L2;}],
    ['empty reason',(v:any)=>{v.copy_units[0].group_checks[1].L1.reason='  ';}],
    ['coerced verdict',(v:any)=>{v.copy_units[0].group_checks[1].L1.verdict=['pass'];}],
    ['missing source',(v:any)=>{delete v.copy_units[0].group_checks[1].source_relations;}],
    ['empty cues',(v:any)=>{v.copy_units[0].group_checks[1].L2.stage_cues=[];}],
    ['nested groups',(v:any)=>{v.copy_units[0].group_checks[1].group_reviews=[];}],
    ['coerced group verdict',(v:any)=>{v.copy_units[0].group_checks[1].verdict=['pass'];}],
  ] as const) {
    const raw: any = structuredClone(groupedRawResponse);change(raw);const req=groupRequest();let attempts=0;
    const mock={...groupDeps,run:async()=>{attempts++;return raw;}};
    await assert.rejects(reviewClipMentorCopy(req,mock),name+' must not create a successful receipt');
    const ledger=JSON.parse(await readFile(join(root,req.operationId+'.json'),'utf8'));
    assert.equal(ledger.status,'failed');assert.deepEqual(ledger.raw_review,raw);
    await assert.rejects(reviewClipMentorCopy(req,mock,undefined,true));assert.equal(attempts,1,name+' recovery is read-only');
  }
}
