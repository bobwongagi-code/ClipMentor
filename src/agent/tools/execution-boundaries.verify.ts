// Zero-provider replay of the saved C1 failure. Run through scripts/run-check.mjs.
import assert from 'node:assert/strict';
import fixture from './fixtures/barely-there-bookend-replacement-20261029.json';
import { isProjectStoreRequest } from '../../../shared/project-store-validation';
import { assertDeliveryPicturePreservation } from '../../clipmentor/delivery-bindings';
import { TEMPLATES } from '../../editor/initial';
import { makeDraft } from '../../editor/store';
import type { ProjectDoc } from '../../editor/types';
import { execEditItemTool } from './edit-item-tools';
import { SaveCoordinator } from '../../persist/projectStoreCoordinators';
import { createProjectDocumentStoreOperation } from '../../../server/plugins/project-store-project-document';
import { projectEditOwnershipKey, renewedProjectEditOwnership } from '../../../server/external-agent/project-edit-ownership-codec';
import { revisionOf } from '../external-edit-session';
import type { LockedProjectStore } from '../../../server/plugins/project-store';

const group = process.argv.find(arg => ['same-track', 'native-picture', 'late-save', 'queued-save','replacement-effective-duration','native-before-voice','native-rebuilt-audio','replacement-unrelated-placement'].includes(arg));
let checked = 0;
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Network forbidden in this regression'); };
const before = fixture.before as unknown as ProjectDoc;
const args = fixture.args;
const context = (doc = before) => {
  const engine = makeDraft(structuredClone(doc));
  return { ...engine, getCreativeMode: () => 'clipmentor', templates: [], audio: [] };
};
const run = async (name: string, test: () => Promise<void>) => {
  if (group && name !== group) return;
  await test(); checked++; console.log(`PASS ${name}`);
};
try {
  await run('same-track', async () => {
    const ctx = context();
    const deletes = args.deletes.filter(d => d.type === 'motion-graphic');
    const result = await execEditItemTool('edit_item', { adds: args.adds, deletes }, ctx) as any;
    assert.equal(result.ok, true, JSON.stringify(result));
    for (const add of args.adds) {
      const item = ctx.getState().items.find(i => i.sourceAssetId === add.assetId || i.templateId === add.assetId);
      assert(item, add.assetId);
      assert.equal(item.startFrame, add.fromFrame, 'atomic same-track replacement must retain the requested frame');
    }
    assert.equal(Math.max(...ctx.getState().items.map(i => i.startFrame + i.durationInFrames)), 3071);
    assert.equal(ctx.getState().items.length, before.timelines[0].items.length);
    const replaced = new Set(deletes.map(d => d.itemId));
    for (const item of before.timelines[0].items.filter(i => !replaced.has(i.id))) {
      assert.deepEqual(ctx.getState().items.find(i => i.id === item.id), item, 'unrelated middle/audio/native instances must be byte-equivalent');
    }
    assert.equal((result.results[0].placed as any).assetId,args.adds[0].assetId,'results retain request order despite internal staging');
  });
  await run('native-picture', async () => {
    const ctx = context(); const snapshot = structuredClone(ctx.getDoc());
    const result = await execEditItemTool('edit_item', args, ctx) as any;
    assert.equal(result.ok, false, 'the saved failure must be rejected before any project mutation');
    assert.match(String(result.error), /delivery_native_picture/);
    assert.deepEqual(ctx.getDoc(), snapshot, 'a missing binding rolls back the entire batch');
  });
  await run('late-save', async () => {
    const projectId = 'zero-call-run-guard'; const key = `project:${projectId}`;
    const claim = { projectId, ownerKind: 'browser' as const, ownerId: 'fixture-browser', epoch: 1, baseRevision: revisionOf(before) };
    const values = new Map<string, unknown>([[key, before], [projectEditOwnershipKey(projectId), renewedProjectEditOwnership(claim, claim.baseRevision)]]);
    const store: LockedProjectStore = {
      readEntry: async k => values.has(k) ? { found: true, value: values.get(k) } : { found: false },
      writeEntry: async (k, v) => { values.set(k, v); },
      writeEntryExact: async (k, v) => { values.set(k, v); },
      writeAgentRuntimeExact: async (k, v) => { values.set(k, v); },
      removeEntry: async k => { values.delete(k); },
    };
    let status = 'failed';
    const writer = createProjectDocumentStoreOperation(async work => work(store), () => ({ projectId, status }));
    const changed = { ...before, timelines: before.timelines.map(t => ({ ...t, name: 'late pending edit' })) };
    const request = { operation: 'project-document-write' as const, key, expectedRevision: claim.baseRevision, ownerId: claim.ownerId, ownershipEpoch: 1, value: changed, agentRunId: 'expired-run' };
    const refused = await writer(request);
    assert.equal(refused.accepted, false, 'server-terminal run must not write, even if browser has not received done');
    assert.equal(refused.error?.code, 'agent_run_not_active');
    assert.deepEqual(values.get(key), before);
    status = 'running';
    assert.equal((await writer(request)).accepted, true, 'the matching active run must save normally');
    const committed = values.get(key);
    status = 'failed';
    assert.equal((await writer({ ...request, value: before })).accepted, false);
    assert.deepEqual(values.get(key), committed, 'failure cannot erase the previous saved edit');
    const { agentRunId: _, ...manual } = request;
    assert.equal((await writer({ ...manual, value: before })).accepted, true, 'ordinary manual editing after a run is allowed');
  });
  await run('queued-save', async () => {
    let release!: () => void; let calls = 0;
    const block = new Promise<void>(resolve => { release = resolve; });
    const coordinator = new SaveCoordinator(async () => { calls++; if (calls === 1) await block; return { saved: true, indexUpdated: true }; });
    const accepted = coordinator.enqueue('queue', before);
    const abort = new AbortController();
    const pending = coordinator.enqueue('queue', before, { agentRunId: 'run-queue', signal: abort.signal });
    abort.abort(); release();
    assert.equal((await accepted).saved, true);
    assert.equal((await pending).saved, false, 'cancelled queued snapshot must never reach the persistence callback');
    assert.equal(calls, 1);
    assert.equal((await coordinator.enqueue('queue', before)).saved, true, 'cancelled checkpoint must not poison later manual saves');
  });
  await run('dry-run-parity', async () => {
    const ctx=context(); const snapshot=structuredClone(ctx.getDoc());
    const bad=await execEditItemTool('edit_item',{...args,validateOnly:true},ctx) as any;
    assert.equal(bad.ok,false);assert.match(String(bad.error),/delivery_native_picture/);
    const good=await execEditItemTool('edit_item',{adds:args.adds,deletes:args.deletes.filter(d=>d.type==='motion-graphic'),validateOnly:true},ctx) as any;
    assert.equal(good.ok,true);assert.deepEqual(ctx.getDoc(),snapshot);
  });
  await run('remaining-collision-atomic',async()=>{
    const doc=structuredClone(before);const old=doc.timelines[0].items.find(i=>i.id===args.deletes[0].itemId)!;
    doc.timelines[0].items.push({...old,id:'occupied-neighbour',startFrame:100,durationInFrames:10});
    const ctx=context(doc),snapshot=structuredClone(ctx.getDoc());
    const result=await execEditItemTool('edit_item',{adds:[args.adds[0]],deletes:[args.deletes[0]]},ctx) as any;
    assert.equal(result.ok,false);assert.match(String(result.error),/replacement_position_conflict/);
    assert.deepEqual(ctx.getDoc(),snapshot);
  });
  await run('later-invalid-entry-rolls-back',async()=>{
    const ctx=context(),snapshot=structuredClone(ctx.getDoc());
    const result=await execEditItemTool('edit_item',{adds:args.adds,deletes:[...args.deletes.filter(d=>d.type==='motion-graphic'),{type:'image',itemId:'missing'}]},ctx) as any;
    assert.equal(result.ok,false);assert.deepEqual(ctx.getDoc(),snapshot);
  });
  await run('track-alias-and-start-alias',async()=>{
    const ctx=context();const track=ctx.getState().items.find(i=>i.id===args.deletes[0].itemId)!.track;
    const adds=args.adds.map(a=>({type:a.type,assetId:a.assetId,startFrame:a.fromFrame,trackId:track}));
    const result=await execEditItemTool('edit_item',{adds,deletes:args.deletes.filter(d=>d.type==='motion-graphic')},ctx) as any;
    assert.equal(result.ok,true,JSON.stringify(result));
    for(const add of adds)assert.equal(ctx.getState().items.find(i=>i.sourceAssetId===add.assetId)!.startFrame,add.startFrame);
  });
  await run('native-replacement-allowed',async()=>{
    const ctx=context();const old=ctx.getState().items.find(i=>i.id===args.deletes[2].itemId)!;
    const result=await execEditItemTool('edit_item',{deletes:[args.deletes[2]],adds:[{type:'image',assetId:old.sourceAssetId,track:old.track,fromFrame:old.startFrame,durationInFrames:old.durationInFrames}]},ctx) as any;
    assert.equal(result.ok,true,JSON.stringify(result));
  });
  await run('native-coverage-and-normal-edits',async()=>{
    const original=before.timelines[0].items.find(i=>i.id===args.deletes[2].itemId)!;
    const doc=structuredClone(before),timeline=doc.timelines[0];
    const at=timeline.items.findIndex(i=>i.id===original.id),half=Math.floor(original.durationInFrames/2);
    timeline.items.splice(at,1,{...original,id:'split-a',durationInFrames:half},{...original,id:'split-b',startFrame:original.startFrame+half,durationInFrames:original.durationInFrames-half});
    assert.doesNotThrow(()=>assertDeliveryPicturePreservation(before,doc),'contiguous native split keeps binding');
    timeline.items[at].durationInFrames--;
    assert.throws(()=>assertDeliveryPicturePreservation(before,doc),/delivery_native_picture/,'one-frame uncovered range is still missing binding');
    const adjusted=structuredClone(before);adjusted.timelines[0].items.find(i=>i.id===original.id)!.transform={x:10,y:0,scale:1,rotation:0,opacity:1};
    assert.doesNotThrow(()=>assertDeliveryPicturePreservation(before,adjusted),'layout edits keep native binding');
    const incomplete=structuredClone(before);incomplete.timelines[0].items.find(i=>i.id===original.id)!.durationInFrames=10;
    assert.doesNotThrow(()=>assertDeliveryPicturePreservation(incomplete,incomplete),'unrelated changes do not turn a previously incomplete image into a new full-span obligation');
    const empty=structuredClone(before);empty.timelines[0].items=[];
    assert.doesNotThrow(()=>assertDeliveryPicturePreservation(empty,before),'initial construction/repair stays allowed');
    const ctx=context();const unrelated=ctx.getState().items.find(i=>i.kind==='motion-graphic')!;
    assert.equal((await execEditItemTool('edit_item',{deletes:[{type:'motion-graphic',itemId:unrelated.id}]},ctx) as any).ok,true);
  });
  await run('cancelled-tool-publishes-nothing',async()=>{
    const engine=context(),snapshot=structuredClone(engine.getDoc()),controller=new AbortController();controller.abort();
    const ctx={...engine,getAgentRunSignal:()=>controller.signal};
    for(const validateOnly of [false,true]) {
      const result=await execEditItemTool('edit_item',{adds:args.adds,deletes:args.deletes.filter(d=>d.type==='motion-graphic'),validateOnly},ctx) as any;
      assert.equal(result.ok,false);assert.deepEqual(engine.getDoc(),snapshot);
    }
  });
  await run('server-save-races-and-statuses',async()=>{
    for(const status of ['failed','cancelled','completed','waiting_approval','missing','wrong-project','aborted-running']) {
      const projectId='status-project',key=`project:${projectId}`,values=new Map<string,unknown>([[key,before]]);
      const store:LockedProjectStore={readEntry:async k=>values.has(k)?{found:true,value:values.get(k)}:{found:false},writeEntry:async()=>{},writeEntryExact:async(k,v)=>{values.set(k,v);},writeAgentRuntimeExact:async()=>{},removeEntry:async k=>{values.delete(k);}};
      const abort=new AbortController();if(status==='aborted-running')abort.abort();
      const writer=createProjectDocumentStoreOperation(async work=>work(store),()=>status==='missing'?undefined:{projectId:status==='wrong-project'?'other':projectId,status:['wrong-project','aborted-running'].includes(status)?'running':status,abort});
      const result=await writer({operation:'project-document-write',key,expectedRevision:'base',ownerId:'owner',ownershipEpoch:1,value:before,agentRunId:'fixture'});
      assert.equal(result.accepted,false,status);assert.equal(result.error?.code,'agent_run_not_active');assert.deepEqual(values.get(key),before);
    }
    for(const stage of ['ownership-read','project-write','ownership-write','write-fails','create-write'] as const) {
      const projectId='race-project',key=`project:${projectId}`,ownershipKey=projectEditOwnershipKey(projectId);
      const claim={projectId,ownerKind:'browser' as const,ownerId:'fixture-owner',epoch:1,baseRevision:revisionOf(before)};
      const ownership=renewedProjectEditOwnership(claim,claim.baseRevision),creating=stage==='create-write';
      const values=new Map<string,unknown>(creating?[]:[[key,before],[ownershipKey,ownership]]);
      let status='running',trigger=true;
      const store:LockedProjectStore={
        readEntry:async k=>{if(stage==='ownership-read'&&k===ownershipKey)status='failed';return values.has(k)?{found:true,value:values.get(k)}:{found:false};},
        writeEntry:async()=>{},writeAgentRuntimeExact:async()=>{},removeEntry:async k=>{values.delete(k);},
        writeEntryExact:async(k,v)=>{values.set(k,v);if(trigger&&((stage==='ownership-write'&&k===ownershipKey)||(stage!=='ownership-write'&&k===key))){trigger=false;if(stage==='write-fails')throw new Error('injected fs failure');status='failed';}},
      };
      const writer=createProjectDocumentStoreOperation(async work=>work(store),()=>({projectId,status}));
      const changed={...before,timelines:before.timelines.map(t=>({...t,name:'pending'}))};
      const request={operation:'project-document-write' as const,key,expectedRevision:creating?null:claim.baseRevision,ownerId:claim.ownerId,ownershipEpoch:1,value:changed,agentRunId:'fixture'};
      if(stage==='write-fails')await assert.rejects(writer(request as any),/injected fs failure/);
      else {const result=await writer(request as any);assert.equal(result.accepted,false,stage);}
      assert.deepEqual(values.get(key),creating?undefined:before,stage+' restores the last saved document');
      assert.deepEqual(values.get(ownershipKey),creating?undefined:ownership,stage+' restores ownership with it');
    }
  });
  await run('server-native-binding-cannot-be-bypassed',async()=>{
    const projectId='picture-write',key=`project:${projectId}`,claim={projectId,ownerKind:'browser' as const,ownerId:'owner',epoch:1,baseRevision:revisionOf(before)};
    const values=new Map<string,unknown>([[key,before],[projectEditOwnershipKey(projectId),renewedProjectEditOwnership(claim,claim.baseRevision)]]);
    const store:LockedProjectStore={readEntry:async k=>values.has(k)?{found:true,value:values.get(k)}:{found:false},writeEntry:async()=>{},writeEntryExact:async(k,v)=>{values.set(k,v);},writeAgentRuntimeExact:async()=>{},removeEntry:async k=>{values.delete(k);}};
    const writer=createProjectDocumentStoreOperation(async work=>work(store),()=>({projectId,status:'running'}));
    const missing=structuredClone(before);missing.timelines[0].items=missing.timelines[0].items.filter(i=>i.id!==args.deletes[2].itemId);
    await assert.rejects(writer({operation:'project-document-write',key,expectedRevision:claim.baseRevision,ownerId:claim.ownerId,ownershipEpoch:1,agentRunId:'fixture',value:missing}),/delivery_native_picture/);
    assert.deepEqual(values.get(key),before,'other tool paths cannot commit a lost native image');
  });
  await run('run-context-is-snapshot-scoped',async()=>{
    const contexts:Array<string|undefined>=[];
    const coordinator=new SaveCoordinator(async(_id,_doc,ctx)=>{contexts.push(ctx?.agentRunId);return {saved:true,indexUpdated:true};});
    const ctx={agentRunId:'first'};const first=coordinator.enqueue('scoped',before,ctx);ctx.agentRunId='second';
    const second=coordinator.enqueue('scoped',before,ctx);await Promise.all([first,second]);
    await coordinator.enqueue('scoped',before);
    assert.deepEqual(contexts,['first','second',undefined]);
  });
  await run('write-contract',async()=>{
    const base={operation:'project-document-write',key:'project:fixture',value:before,expectedRevision:null};
    assert.equal(isProjectStoreRequest(base),true);
    assert.equal(isProjectStoreRequest({...base,agentRunId:'active-run'}),true);
    const update={...base,expectedRevision:'revision',ownerId:'owner',ownershipEpoch:1};
    assert.equal(isProjectStoreRequest(update),true);assert.equal(isProjectStoreRequest({...update,agentRunId:'run'}),true);
    for(const agentRunId of ['',null,1,[],{},'bad/run','x'.repeat(161)])assert.equal(isProjectStoreRequest({...update,agentRunId}),false);
    assert.equal(isProjectStoreRequest({...update,agentRunId:'run',unknown:true}),false);
  });
  await run('replacement-effective-duration',async()=>{
    const doc=structuredClone(before);delete doc.clipMentorAnalysis;
    const old=doc.timelines[0].items.find(i=>i.id===args.deletes[0].itemId)!;
    old.startFrame=100;old.durationInFrames=10;doc.timelines[0].items=[old];
    const ctx=context(doc);
    const result=await execEditItemTool('edit_item',{adds:[{...args.adds[0],assetId:args.adds[0].assetId.slice(0,8)}],deletes:[args.deletes[0]]},ctx) as any;
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(ctx.getState().items[0].startFrame,0,'prefix resolution must use the real media duration, not one frame');
    const template=TEMPLATES.find(t=>t.durationInFrames>110)!;assert(template);
    const lib={...context(doc),templates:[template]};
    const libraryResult=await execEditItemTool('edit_item',{adds:[{type:'motion-graphic',assetId:'library:motion-graphic:'+template.id,track:'V4',fromFrame:0}],deletes:[args.deletes[0]]},lib) as any;
    assert.equal(libraryResult.ok,true,JSON.stringify(libraryResult));
    assert.equal(lib.getState().items[0].startFrame,0,'library templates must use their actual duration too');
  });
  await run('native-before-voice',async()=>{
    const doc=structuredClone(before);doc.assets=doc.assets.filter(a=>a.kind!=='audio');
    doc.timelines[0].items=doc.timelines[0].items.filter(i=>i.kind!=='audio');
    for(const u of doc.clipMentorAnalysis!.blueprint){const i=(u as any).internal_review,p=i[i.current_picture_plan];for(const section of p?.delivery_sections??[])delete section.voice.existing_audio;}
    assert.doesNotThrow(()=>assertDeliveryPicturePreservation(doc,doc),'an unchanged image remains editable before voice exists');
    const missing=structuredClone(doc);missing.timelines[0].items=missing.timelines[0].items.filter(i=>i.id!==args.deletes[2].itemId);
    assert.throws(()=>assertDeliveryPicturePreservation(doc,missing),/delivery_native_picture/,'lack of audio must not waive image preservation');
  });
  await run('native-rebuilt-audio',async()=>{
    const doc=structuredClone(before),image=doc.timelines[0].items.find(i=>i.id===args.deletes[3].itemId)!;
    const original=doc.timelines[0].items.find(i=>i.kind==='audio'&&i.startFrame===image.startFrame)!;assert(original);
    original.id='rebuilt-same-audio';original.startFrame+=10;image.startFrame+=10;
    assert.doesNotThrow(()=>assertDeliveryPicturePreservation(before,doc),'rebuilding the same bound audio and picture together keeps their relationship');
  });
  await run('replacement-unrelated-placement',async()=>{
    const doc=structuredClone(before);delete doc.clipMentorAnalysis;
    const extra={type:'text',text:'ordinary add',track:'V1',fromFrame:0};
    const normal=context(doc);const normalResult=await execEditItemTool('edit_item',{adds:[extra]},normal) as any;
    assert.equal(normalResult.ok,true);
    const expected=normal.getState().items.find(i=>i.id===normalResult.results[0].placed.itemId)!.startFrame;
    const ctx=context(doc);const result=await execEditItemTool('edit_item',{adds:[args.adds[0],extra],deletes:[args.deletes[0]]},ctx) as any;
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(ctx.getState().items.find(i=>i.id===result.results[1].placed.itemId)!.startFrame,expected,'unrelated placement retains its ordinary collision policy');
  });
  assert(checked > 0, 'the selected regression must actually execute');
  assert.equal(networkCalls, 0);
} finally { globalThis.fetch = originalFetch; }
console.log(`execution-boundaries.verify: ${checked} cases, ${networkCalls} network/model calls`);
