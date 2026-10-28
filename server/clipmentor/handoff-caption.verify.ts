import type { ProjectDoc } from '../../src/editor/types';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=await mkdtemp(join(tmpdir(),'handoff-security-repro-'));
process.env.OPENCHATCUT_DATA_DIR=root;
const {withSerializedProjectStore}=await import('../../server/plugins/project-store.ts');
const {activateOfflineAgentRuntimeBackend}=await import('../../server/external-agent/agent-runtime-persistence.ts');activateOfflineAgentRuntimeBackend();
const {makeDraft}=await import('../../src/editor/store.ts');
const {executeTool}=await import('../../src/agent/tools.ts');
const {copyReviewSubject,copyTeachingPacketFromDoc,checkCopyProduction}=await import('../../src/clipmentor/production-gate.ts');
const {reviewClipMentorCopy}=await import('../../server/clipmentor/copy-review.ts');
const {digestValue}=await import('../../server/agent-runs/store-values.ts');
const {default:regression}=await import('../../src/clipmentor/fixtures/copy-teaching-blind-v2-20261019.json');
const oracle = regression.regression_oracles.find((o) => o.label === 'qualified_scent_excerpt_from_revision95')!;
const positive = regression.blind_input.cases.find((c) => c.case_id === oracle.case_id)!.packet.units[0];
const rawPoint = regression.raw_review.cases.find((c) => c.case_id === oracle.case_id)!.units[0].points[0];
const line = positive.lines[0];
const base: ProjectDoc = {
  version: 3, activeTimelineId: 'tl', mediaFolders: [],
  assets: [{ id: 'source', name: 'synthetic source', kind: 'video', src: '/media/uploads/review-test.mp4', sourceContentHash: 'a'.repeat(64), durationInFrames: 3000 }],
  timelines: [{ id: 'tl', name: 'test', order: 0, fps: 30, width: 576, height: 1024, items: [], selectedId: null }],
  clipMentorAnalysis: { schema_version: 1, analysis_id: 'synthetic-review-test', revision: 1,
    source: { asset_id: 'source', sourceContentHash: 'a'.repeat(64), duration_seconds: 100, fps: 30 },
    product: { name: 'Test soap', category: 'soap' }, import_origin: 'synthetic_test', points: [], transcripts: [], reviews: [], audit: [],
    evidence: [{ evidence_id: 'F1', kind: 'source_frame', text: 'Test position; not a real observation', status: 'historical_unknown',
      supporting_evidence_ids: [], source_ids: [], time_seconds: 60, source_frame: 1800,
      observation_method: 'synthetic_test', call_status: 'historical_unknown' }],
    blueprint: [{ unit_id: 'U1', point_ids: ['P1'], intent_zh: 'test use experience', line_guidance: '',
      ...{ internal_review: { current_script_candidate: 'copy', current_picture_plan: 'picture_plan_test',
        copy: { lines: [{ id: line.line_id, point_ids: ['P1'], narration_ms: line.narration_ms, caption_lines: line.caption_lines,
          zh: line.meaning_zh, source_seconds: [59.4, 62.2], labels: line.labels }] },
        picture_plan_test: { script_candidate_id: 'copy', source_range: [59.4, 62.2], composition: 'CURRENT_PLAN_CONTENT',
          viewer_stage_cues: { layout: { original: 'ORIGINAL_LAYOUT', revisit: 'REVISIT_LAYOUT', safe_area: 'SAFE_AREA' },
            original: { text: 'Video asal', enter: 'ORIGINAL_ENTER', exit: 'ORIGINAL_EXIT' },
            revisit: [{ line_ids: [line.line_id], text: 'Ulang lihat', enter: 'REVISIT_ENTER', exit: 'REVISIT_EXIT' }],
            handoff: 'CURRENT_HANDOFF' },
          phases: [{ line_id: line.line_id, source_seconds: [59.4, 62.2], picture: 'CURRENT_PICTURE',
            purpose: 'CURRENT_USE', constraints: ['CURRENT_CONSTRAINT'], details: { text: 'AUTHOR_PHASE_WRAPPER' } }],
          knownIssue: 'AUTHOR_SINGULAR_MUST_NOT_LEAK', selfEvaluation: 'AUTHOR_SELF_MUST_NOT_LEAK',
          context: [{ kind: 'previous_drafts', text: 'AUTHOR_WRAPPED_MUST_NOT_LEAK' }],
          self_review: 'AUTHOR_VERDICT_MUST_NOT_LEAK', reason: 'AUTHOR_REASON_MUST_NOT_LEAK', production_allowed: true,
          known_issues: ['AUTHOR_EXPECTATION_MUST_NOT_LEAK'], previous_drafts: ['AUTHOR_HISTORY_MUST_NOT_LEAK'],
          user_feedback: 'AUTHOR_PREFERRED_ANSWER_MUST_NOT_LEAK', expected_answer: 'AUTHOR_PASS_MUST_NOT_LEAK',
          details: { knownIssues: ['AUTHOR_CAMEL_CASE_MUST_NOT_LEAK'], expectedAnswer: 'AUTHOR_NESTED_MUST_NOT_LEAK' } } } } }],
    source_breakdown: { version: 1, review_scope: { kind: 'local_ranges', source_ranges: [[59.4, 62.2]], instruction: 'Synthetic local task boundary, independent of playback choices' },
      segments: [{ segment_id: 'S1', source_range_seconds: [59.4, 62.2], visible_evidence_ids: ['F1'], claim_evidence_ids: [], interpretation_evidence_ids: [], unknowns: ['Scent quality unknown'] }],
      points: [{ point_id: 'P1', segment_ids: ['S1'], buying_concern: 'Use experience', teaching_question: positive.points[0].question,
        filming_conditions: ['Near-nose gesture'], role: 'primary', importance: 'must_explain' }],
      units: [{ unit_id: 'U1', original_segment_ids: ['S1'], original_source_ranges: [[59.4, 62.2]], explanation_segment_ids: ['S1'],
        coverage: [{ point_id: 'P1', treatment: 'explain' }], revisits: [{ from_segment_id: 'S1', to_segment_id: 'S1', reason: 'AUTHOR_REVISIT_REASON_MUST_NOT_LEAK' }] }],
    },
  },
};
const goodRaw = () => ({ cases: [{ case_id: 'current', units: [{ unit_id: 'U1', points: [{ ...structuredClone(rawPoint), point_id: 'P1' }] }] }],
  copy_units: [{ unit_id: 'U1', verdict: 'pass', findings: [],
    group_checks: { scope: 'planned_group_teaching_only',
      source_relations: [{ relation: 'Synthetic source relation', evidence_ids: ['F1'], point_ids: ['P1'], line_ids: [line.line_id], assessment: 'covered', reason: 'Synthetic protocol fixture, not semantic approval' }],
      L1: { verdict: 'pass', learner_takeaway: 'Synthetic group relationship', reason: 'Synthetic teaching coverage, not a real semantic result' },
      L2: { verdict: 'pass', viewer_chain: 'Synthetic original then revisit', stage_cues: 'Synthetic visible revisit title', reason: 'Synthetic planned handoff, not actual viewing' } },
    narration_checks: [{ line_id: line.line_id, necessity: 'necessary',
    omission_loss: 'Synthetic test: scent-use relation would be lost', naturalness: 'natural', reason: 'Synthetic reviewer only, not a real naturalness judgment' }] }] });

try {
const subject=await copyReviewSubject(base),packet=await copyTeachingPacketFromDoc(base);
const request={operationId:'11111111-1111-4111-8111-111111111111',maxRequests:1,projectId:'test-project',authorRunId:'author',source:{src:base.assets[0].src,hash:'a'.repeat(64),fps:30,duration:100},subject:{revision:subject.revision,digest:subject.digest,units:subject.units.map(({unit_id,candidate_id})=>({unit_id,candidate_id}))},packet};
const reviewed=await reviewClipMentorCopy(request,{directory:root,resolve:()=> 'mock',hash:async()=> 'a'.repeat(64),frame:async()=> 'aGVsbG8=',run:async()=>goodRaw()});
base.clipMentorAnalysis.production_copy_review=reviewed.receipt;
base.timelines[0].items=[{id:'voice',track:'A1',startFrame:0,durationInFrames:120,name:'voice',kind:'audio',src:'/synthetic.mp3',transcript:line.narration_ms.split(' ').map((text,i)=>({text,start:i*100,end:(i+1)*100}))}];
base.timelines[0].captions={enabled:true,template:'plain',pacing:'phrase',sourceItemId:'voice'};
const projectId='test-project',runId='45454545-4545-4545-8545-454545454545';
const brief={version:1,briefId:'frozen',revision:1,mode:'collaborative',phase:'execution',planner:'external_codex',executor:'builtin_agent',projectId,timelineId:'tl',objective:'Implement exact frozen captions',doneCriteria:['Frozen words'],blueprint:{revision:subject.revision,digest:subject.digest},budget:{maxModelTurns:1,maxToolCalls:1,maxElapsedMs:60000,paidToolCalls:{}}};
const assetBindings=base.assets.map(a=>Object.fromEntries(['id','kind','src','sourceContentHash','sourceRevision','durationInFrames','width','height'].map(k=>[k,a[k]??null])));
const digest=digestValue({templateVersion:'clipmentor-handoff-v1',brief,assetBindings});
await withSerializedProjectStore(async s=>{await s.writeEntry('clipmentor-handoff:'+projectId,{version:1,brief,digest,assetBindings,runIds:[runId],startedAt:Date.now(),modelTurns:0,toolCalls:0,paidCalls:{},callIds:[]});await s.writeEntry('clipmentor-handoff-run:'+projectId+':'+runId,{version:1,projectId,runId,policyDigest:digest,templateVersion:'clipmentor-handoff-v1',payloadArtifactId:'synthetic'});});
const draft=makeDraft(base),ctx={commands:draft.commands,getState:draft.getState,getDoc:draft.getDoc,getCreativeMode:()=> 'clipmentor',getProjectId:()=>projectId,getAgentRunId:()=>runId,templates:[],audio:[]};
assert.equal((await checkCopyProduction(draft.getDoc(),'clipmentor')).allowed,true);
const before=await executeTool('read_captions',{},ctx);
const result=await executeTool('edit_captions',{action:'display_text',json:JSON.stringify({overrides:[{wordIndex:0,text:'UNAPPROVED REPLACEMENT'}]})},ctx);
assert.equal(result.production_gate?.allowed,false,JSON.stringify(result));
assert.match(result.error,/caption_text_not_frozen/);
const after=await executeTool('read_captions',{},ctx);
assert.equal(after.pages[0].words[0].text,before.pages[0].words[0].text,'rejected caption rewrite publishes nothing');
const props=await executeTool('update_item_props',{itemId:'voice',props:{text:'UNAPPROVED REPLACEMENT'}},ctx);assert.equal(props.production_gate?.allowed,false);
const coerced=await executeTool('update_item_props',{itemId:'voice',props:{text:['UNAPPROVED REPLACEMENT']}},ctx);assert.equal(coerced.production_gate?.allowed,false);
const legal=await executeTool('edit_captions',{action:'display_text',json:JSON.stringify({overrides:[{wordIndex:0,forceBreak:true}]})},ctx);assert.equal(legal.ok,true,JSON.stringify(legal));
assert.equal((await copyReviewSubject(draft.getDoc())).digest,subject.digest);
assert.equal((await checkCopyProduction(draft.getDoc(),'clipmentor')).allowed,true);
console.log('handoff captions: real dispatcher refuses frozen-copy rewrites with valid mocked independent review; ordinary layout/page break edit accepted; zero provider calls');
} finally {await rm(root,{recursive:true,force:true});}
