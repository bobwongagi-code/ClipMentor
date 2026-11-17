import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {ProductionInput,ProductionTask} from './production-task';

// Exercise real file persistence and archive publication, without HTTP, workers or media.
const directory=await fs.mkdtemp(join(tmpdir(),'production-compaction-authority-'));
const previousData=process.env.OPENCHATCUT_DATA_DIR,previousSqlite=process.env.OPENCHATCUT_SQLITE_STORE;
process.env.OPENCHATCUT_DATA_DIR=directory;process.env.OPENCHATCUT_SQLITE_STORE='0';
const {activateOfflineAgentRuntimeBackend}=await import('../external-agent/agent-runtime-persistence');
const {createProductionTask,productionTaskStore}=await import('./production-task');
const {prepareSharedProduction,continuationBrief}=await import('./production-continuation');
const {loadAgentRuntimeSidecar,loadAgentArtifact,resetAgentRuntimeStoreMemory}=await import('../../src/persist/agentRuntimeStore');
const {unpackProductionHistory}=await import('./production-task-history');
const {flushServerRunPersistence,resetServerRunStoreForTest}=await import('../agent-runs/store');
const {resetSharedKvMemory}=await import('../../src/persist/sharedKv');
resetSharedKvMemory();resetAgentRuntimeStoreMemory();resetServerRunStoreForTest();activateOfflineAgentRuntimeBackend();
const input=(projectId:string):ProductionInput=>({projectId,sourceAssetId:'source',product:{name:'compaction authority fixture',category:'test'},brief:'parent brief',humanBlueprintReview:true,author:{provider:'openai',model:'fixture',apiMode:'responses',origin:'http://127.0.0.1:1'},reviewer:{provider:'openai',model:'fixture',apiMode:'responses',origin:'http://127.0.0.1:1'},budget:{model:10,review:10,observation:0,tts:0,render:0,maxElapsedMs:60000,maxRepairs:0}});
const legacyBrief=(parent:ProductionTask)=>parent.input.brief+'\n用户已确认含两种结尾的完整蓝图。本执行任务负责其中的new_contact输出；两版共用片头、教学主体与同文配音，仅片尾不同。从独立审核接续，不重新分析原片。片尾使用独立时间线实例，片头和教学主体的实例在片尾起点前闭合，便于直接复用实际剪辑。';
const results=[];
try{
 for(const count of [191,192]){
  const parent=await createProductionTask(input('compaction-parent-'+count));
  const child=await createProductionTask(input('compaction-child-'+count));
  child.input.panelDelivery={productAssetId:'product',productAssetHash:'a'.repeat(64),salesAssetId:'sales',ctaAssetId:'cta',ctaAssetHash:'b'.repeat(64),audience:'new_contact'};
  child.blueprintApproval={sourceProjectId:parent.projectId,sourceTaskId:parent.taskId,sourceRevision:'fixture',digest:'fixture',requirementsDigest:'fixture',confirmedAt:1};
  child.input.brief=legacyBrief(parent);
  child.attempts.model=3;child.attempts.review=2;
  for(let i=1;i<count;i++)await productionTaskStore.save(child);
  parent.productionChild={projectId:child.projectId,taskId:child.taskId,audience:'new_contact'};await productionTaskStore.save(parent);
  const before=await loadAgentRuntimeSidecar(child.projectId),beforeTask=await productionTaskStore.load(child.projectId,child.taskId),beforeParent=await productionTaskStore.load(parent.projectId,parent.taskId);
  assert.equal(before.artifacts.length,count);
  assert.equal(await prepareSharedProduction(child),true);
  const after=await loadAgentRuntimeSidecar(child.projectId),saved=await productionTaskStore.load(child.projectId,child.taskId);
  assert.equal(after.sessionGeneration??'legacy','legacy');
  const {updatedAt:_beforeAt,sequence:beforeSequence,...unchanged}=beforeTask;
  assert.deepEqual(saved,{...unchanged,input:{...beforeTask.input,brief:continuationBrief(child.input.product.name,'new_contact')},sequence:beforeSequence+1,updatedAt:saved.updatedAt},'only the requested brief and checkpoint clock may change');
  assert(saved.updatedAt>beforeTask.updatedAt);
  assert.deepEqual(await productionTaskStore.load(parent.projectId,parent.taskId),beforeParent,'parent authority and counters remain unchanged');
  const archives=after.artifacts.filter(a=>a.toolName==='clipmentor-production-task-history');
  assert.equal(archives.length,count===192?1:0,'threshold still performs real compaction');
  const archivedIds=new Set<string>();
  for(const index of archives){
   const artifact=await loadAgentArtifact(child.projectId,index.artifactId);assert(artifact,'archive body must remain published/readable');
   const rows=unpackProductionHistory(artifact);assert(rows.length>0,'archive must contain original checkpoints');
   for(const row of rows){archivedIds.add(row.artifactId);const task=JSON.parse(row.body).task as ProductionTask;assert.deepEqual(task.attempts,beforeTask.attempts);assert.equal(task.taskId,child.taskId);}
  }
  const retainedIds=new Set(after.artifacts.map(a=>a.artifactId));
  for(const index of before.artifacts)assert(retainedIds.has(index.artifactId)||archivedIds.has(index.artifactId),'every previous checkpoint remains live or losslessly archived');
  results.push({count,legacySingle:true,beforeArtifacts:before.artifacts.length,afterArtifacts:after.artifacts.length,beforeRevision:before.revision,afterRevision:after.revision,historyArchives:archives.length,archivedCheckpoints:archivedIds.size,savedBriefUpgraded:true,attempts:saved.attempts});
 }
 console.log(JSON.stringify({suite:'production-compaction-authority',cases:results},null,2));
}finally{
 await flushServerRunPersistence();resetServerRunStoreForTest();resetSharedKvMemory();resetAgentRuntimeStoreMemory();
 if(previousData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previousData;
 if(previousSqlite===undefined)delete process.env.OPENCHATCUT_SQLITE_STORE;else process.env.OPENCHATCUT_SQLITE_STORE=previousSqlite;
 const target=resolve(directory);assert(target.startsWith(resolve(tmpdir())+'/production-compaction-authority-'));await fs.rm(target,{recursive:true,force:true});
}
