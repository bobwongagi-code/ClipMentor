import { readFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { digestValue } from '../agent-runs/store-values';
import { runtimeProfile } from '../runtime-profile';
import { atomicWriteFile } from '../plugins/project-store-durable';
import type { ProjectDoc } from '../../src/editor/types';
import { revisionOf } from '../../src/agent/external-edit-session';
import { checkSourceBreakdown } from '../../src/clipmentor/source-breakdown';
import { productionBoardPhaseIssues } from './production-readiness';
import { blueprintFindingKeys, pictureRepairFindings } from './production-decisions';

// Bump when a structural rule's predicate or binding coordinates change.
const gateVersion = 'blueprint-playback-v1';
type Probe = { candidate: string; editor: string; approval: string; projectRevision: string; acceptedAt: string;
  attestation: 'editor_viewed_accepted' };
const folder = () => join(runtimeProfile().rootDir, 'clipmentor-gate-probes');

function receiptPath(sourceHash: string, finding: string) {
  return join(folder(), digestValue([gateVersion, sourceHash, finding]) + '.json');
}

async function eligibleProbes(file:string){
  const directory=folder(),prefix=file.slice(directory.length+1)+'.';
  const names=await readdir(directory).catch(error=>{
    if(error.code==='ENOENT')return [];
    throw error;
  });
  const examples=names.filter(name=>name.startsWith(prefix)&&/^[a-f0-9]{64}$/.test(name.slice(prefix.length)));
  const reports=await Promise.all(examples.map(name=>readFile(join(directory,name),'utf8').then(body=>JSON.parse(body) as Probe)));
  const byApproval=new Map<string,Probe[]>();
  for(const report of reports){
    const key=report.approval.trim();
    byApproval.set(key,[...(byApproval.get(key)??[]),report]);
  }
  return [...new Map([...byApproval.values()].filter(entries=>entries.length===1)
    .map(([report])=>[report.candidate,report])).values()];
}

/** Maintainer-only replay entry point. No web or author tool can attest editorial approval. */
export async function recordEditorApprovedGateProbe(doc: ProjectDoc, approval: Omit<Probe,'candidate'>) {
  const analysis = doc.clipMentorAnalysis;
  const source = analysis?.source;
  if (!analysis || !source?.sourceContentHash || approval.attestation!=='editor_viewed_accepted'
    ||!approval.editor?.trim()||!approval.approval?.trim()||!approval.projectRevision?.trim()
    ||!Number.isFinite(Date.parse(approval.acceptedAt))) {
    throw Error('Original identity and an independent editor acceptance record are required');
  }
  const sourceAsset = doc.assets.find(asset => asset.id === source.asset_id);
  if (sourceAsset?.sourceContentHash !== source.sourceContentHash) throw Error('Accepted original binding changed');
  if (revisionOf(doc) !== approval.projectRevision) throw Error('Accepted candidate revision changed');
  // Identity describes what was watched. Renaming IDs, changing audit text
  // or saving the same playback as a new revision does not add another vote.
  const candidate = digestValue(analysis.blueprint.map(unit => {
    const internal = (unit as unknown as {internal_review?:Record<string,any>}).internal_review;
    const plan = internal?.[internal.current_picture_plan];
    const script = internal?.[internal.current_script_candidate];
    return {
      phases: Array.isArray(plan?.phases) ? plan.phases.map((phase:Record<string,unknown>)=>
        [phase.mode==='original'||phase.mode==='explanation'?phase.mode:null,phase.source_range_seconds??phase.source_seconds]) : [],
      copy: Array.isArray(script?.lines) ? script.lines.map((line:Record<string,unknown>)=>typeof line.narration_ms==='string'?line.narration_ms.normalize('NFKC').trim().replace(/\s+/gu,' '):null) : [],
    };
  }));
  const raw = [...productionBoardPhaseIssues(doc),...checkSourceBreakdown(doc).issues];
  const findings = new Set(pictureRepairFindings('blueprint_stage_incomplete:'+JSON.stringify(raw)).flatMap(blueprintFindingKeys));
  const results = [];
  if(findings.size)await mkdir(folder(),{recursive:true,mode:0o700});
  for (const finding of findings) {
    const file = receiptPath(source.sourceContentHash, finding);
    // Separate immutable files avoid losing either accepted example to concurrent registration.
    const example = file+'.'+digestValue([candidate,approval.approval.trim()]);
    const previous=await readFile(example).catch(error=>{
      if(error.code==='ENOENT')return null;
      throw error;
    });
    if(!previous)await atomicWriteFile(example,JSON.stringify({...approval,candidate}));
    const eligible=await eligibleProbes(file);
    const count=eligible.length;
    if(count>=2)await atomicWriteFile(file,JSON.stringify(eligible.slice(0,2)));
    results.push({finding,count,state:count>=2?'suspected_gate_defect':'pending_maintenance_review'});
  }
  return results;
}

export async function firstSuspectedGateDefect(sourceHash:string, issue:unknown) {
  for(const finding of pictureRepairFindings(issue).flatMap(blueprintFindingKeys)){
    if((await eligibleProbes(receiptPath(sourceHash,finding))).length>=2)return finding;
  }
}
