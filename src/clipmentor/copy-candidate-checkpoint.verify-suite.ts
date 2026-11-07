import assert from 'node:assert/strict';
export async function verifyCopyCandidateCheckpoint(actor:{operator:string;executor:string;instruction:string;identity:'local_declared_not_authenticated'}): Promise<void> {
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { useServerRunProposalCallbacks } = await import('../agent/serverRunProposalLifecycle');
  const { makeDraft } = await import('../editor/store');
  const { executeTool } = await import('../agent/tools');
  const { saveProject, loadProject, migrateProjectDoc, projectSaveCoordinator } = await import('../persist/projectStore');
  const { startAgentRun: recordAgentRun } = await import('../agent/runtime-ledger');
  const { installCheckpointStoreFixture } = await import('../persist/checkpointStore.verify-helper');
  const checkpointStore = installCheckpointStoreFixture();
  const startAgentRun: typeof recordAgentRun = async input => {
    const recorder = await recordAgentRun(input);
    checkpointStore.activate(recorder.runId, input.projectId);
    return recorder;
  };
  const { storeAgentArtifact, loadAgentRuntimeSidecar, deleteAgentArtifacts } = await import('../persist/agentRuntimeStore');
  const { checkCopyProduction } = await import('./production-gate');
  const { listVersions } = await import('../persist/versionStore');
  const { loadServerRunDraft } = await import('../agent/serverRunDraftStore');
  type ProjectDoc = import('../editor/types').ProjectDoc;
  type AgentContext = import('../agent/context').AgentContext;
  type AgentHookState = import('../agent/useAgentState').AgentHookState;
  const projectId = 'copy-checkpoint-local-regression';
  const base: ProjectDoc = {
    version: 3, activeTimelineId: 'tl', assets: [{ id: 'source', kind: 'video', name: 'source', src: '/local-test.mp4', sourceContentHash: 'a'.repeat(64), durationInFrames: 3000 }], mediaFolders: [],
    timelines: [{ id: 'tl', name: 'untouched', order: 0, fps: 30, width: 576, height: 1024, items: [], selectedId: null }],
    clipMentorAnalysis: {
      schema_version: 1, analysis_id: 'checkpoint-regression', revision: 1,
      source: { asset_id: 'source', sourceContentHash: 'a'.repeat(64), duration_seconds: 100, fps: 30 },
      product: { name: 'Test soap', category: 'soap' }, import_origin: 'synthetic_verification', points: [], transcripts: [], reviews: [], audit: [],
      evidence: [{ evidence_id: 'F', kind: 'source_frame', text: 'synthetic', status: 'historical_unknown', supporting_evidence_ids: [], source_ids: [], time_seconds: 60, source_frame: 1800, observation_method: 'synthetic', call_status: 'historical_unknown' }],
      blueprint: [{ unit_id: 'U', point_ids: ['P'], intent_zh: 'test', line_guidance: 'old',
        internal_review: { current_script_candidate: 'script_candidate_old', script_candidate_old: { lines: [{ id: 'L', point_ids: ['P'], narration_ms: 'Dia tunjuk tangan.', caption_lines: ['Dia tunjuk tangan.'], zh: '她展示手部。', source_seconds: [59, 62] }] } } } as any],
      source_breakdown: { version: 1,
        segments: [{ segment_id: 'S', source_range_seconds: [59, 62], visible_evidence_ids: ['F'], claim_evidence_ids: [], interpretation_evidence_ids: [], unknowns: [] }],
        points: [{ point_id: 'P', segment_ids: ['S'], buying_concern: 'test', teaching_question: 'test', filming_conditions: ['test'], role: 'primary', importance: 'must_explain' }],
        units: [{ unit_id: 'U', original_segment_ids: ['S'], explanation_segment_ids: ['S'], coverage: [{ point_id: 'P', treatment: 'explain' }], revisits: [{ from_segment_id: 'S', to_segment_id: 'S', reason: 'explain the demonstrated action' }] }] },
    },
  };
  Object.assign(base, migrateProjectDoc(base)!);
  let current = base;
  const live = makeDraft(base);
  const ctx = { getDoc: () => current, getState: live.getState, getCreativeMode: () => null,
    getProjectId: () => projectId, commands: { ...live.commands, applyDoc: (next: ProjectDoc) => { current = next; } } } as AgentContext;
  const state = { ctxRef: { current: ctx }, abortRef: { current: null }, runningRef: { current: false }, llmProviderRef: { current: '' },
    setRunning: () => undefined, setProposalStale: () => undefined, setMessages: () => undefined, setChangeLog: () => undefined } as unknown as AgentHookState;
  let callbacks!: ReturnType<typeof useServerRunProposalCallbacks>;
  function Harness() { callbacks = useServerRunProposalCallbacks(state, ctx, projectId); return null; }
  renderToString(createElement(Harness));
  const previousFetch = globalThis.fetch;
  let realReviewCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (!/^\/api\/agent-runs\/[^/]+\/(draft(?:\/clear)?|settle)$/.test(value)) {
      realReviewCalls++; throw new Error('Unexpected network: ' + value);
    }
    const runId = value.split('/')[3];
    if (value.endsWith('/draft')) {
      const body = JSON.parse(String(init?.body));
      assert(await storeAgentArtifact({ ...body.artifact, version: 1, kind: 'server-run-draft', projectId, runId, createdAt: Date.now() }));
    } else if (value.endsWith('/draft/clear')) {
      const artifacts = (await loadAgentRuntimeSidecar(projectId)).artifacts.filter((a) => a.runId === runId);
      await deleteAgentArtifacts(projectId, artifacts.map((a) => a.artifactId));
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await saveProject(projectId, base);
    const recorder = await startAgentRun({ projectId, userInput: 'checkpoint local regression', askOnly: false });
    const input = { runId: recorder.runId, text: 'save existing candidate only', content: 'test', askOnly: false, references: [], baseDoc: base, resumed: false };
    await callbacks.onRunStart(input);
    const candidate = makeDraft(base);
    const result = await executeTool('revise_clipmentor_analysis', { action: 'set_copy_candidate', id: 'U', expectedRevision: 1,
      actor: { operator: 'test', executor: 'test', instruction: 'Local regression only', identity: 'local_declared_not_authenticated' }, reason: 'Checkpoint existing text without changing it',
      record: { source_candidate_id: 'script_candidate_old', candidate_id: 'script_candidate_new', plan_id: 'picture_plan_new',
        lines: [{ id: 'L', point_ids: ['P'], narration_ms: 'Dia tunjuk tangan.', caption_lines: ['Dia tunjuk tangan.'], zh: '她展示手部。', source_seconds: [59, 62] }],
        plan: { phases: [{ line_id: 'L', source_seconds: [59, 62], picture: 'existing normal-speed range' }] }, line_guidance: 'existing plan, pending' } },
      { ...ctx, commands: candidate.commands, getState: candidate.getState, getDoc: candidate.getDoc });
    assert.equal((result as any).ok, true, JSON.stringify(result));
    const action = { runId: input.runId, toolCallId: 'save-candidate', argsDigest: 'stable', name: 'revise_clipmentor_analysis',
      args: { action: 'set_copy_candidate', expectedRevision: 1 }, result, actions: candidate.takeActions(), baseDoc: base };
    await callbacks.onToolAction(action);
    const saved = await loadProject(projectId);
    assert(checkpointStore.writes.some(r=>r.agentRunId===input.runId),'preparation checkpoint must carry its run identity');
    assert.equal(saved?.clipMentorAnalysis?.revision, 2, 'candidate must be durable BEFORE the next review or run terminal');
    assert.deepEqual(saved?.timelines, base.timelines, 'checkpoint cannot commit timeline edits');
    assert.equal((current.clipMentorAnalysis!.blueprint[0] as any).internal_review.current_script_candidate, 'script_candidate_new');
    assert((current.clipMentorAnalysis!.blueprint[0] as any).internal_review.script_candidate_old, 'history survives');
    assert.equal((await checkCopyProduction(current, null)).allowed, false);
    const planDraft = makeDraft(current);
    const planArgs = { action: 'set_picture_plan', id: 'U', expectedRevision: 2,
      actor: { operator: 'test', executor: 'test', instruction: 'Local plan persistence check', identity: 'local_declared_not_authenticated' }, reason: 'Same pictures, distinct preparation version',
      record: { script_candidate_id: 'script_candidate_new', plan_id: 'picture_plan_second', plan: { phases: [{ line_id: 'L', source_seconds: [59, 62] }] }, line_guidance: 'same pending plan' } };
    const planResult = await executeTool('revise_clipmentor_analysis', planArgs, { ...ctx, commands: planDraft.commands, getDoc: planDraft.getDoc, getState: planDraft.getState });
    assert.equal((planResult as any).ok, true);
    await callbacks.onToolAction({ ...action, toolCallId: 'save-picture-plan', args: planArgs, result: planResult, actions: planDraft.takeActions() });
    assert.equal((await loadProject(projectId))?.clipMentorAnalysis?.revision, 3);
    // Simulate a reload with the real durable draft journal (base 1, checkpoints 2 and 3).
    renderToString(createElement(Harness));
    const recovered = await callbacks.onRunStart({ ...input, resumed: true });
    assert.equal(recovered.draftDoc?.clipMentorAnalysis?.revision, 3);
    assert.equal(recovered.baseDoc?.clipMentorAnalysis?.revision, 3);
    await callbacks.onToolAction(action); // already seen in the recovered journal
    assert.equal((await loadProject(projectId))?.clipMentorAnalysis?.revision, 3, 'recovery must not duplicate or reject an earlier committed checkpoint');
    await callbacks.onToolAction({ ...action, toolCallId: 'failed-review', name: 'request_clipmentor_copy_review', args: {},
      result: undefined, error: 'Independent review preflight failed: source_breakdown_not_ready', actions: [] });
    await callbacks.onTerminal({ runId: input.runId, status: 'failed', assistantText: 'review failed, candidate must remain' });
    assert.equal((await loadProject(projectId))?.clipMentorAnalysis?.revision, 3, 'review failure must not discard the candidate');
    assert((await listVersions(projectId)).some((v) => v.doc.clipMentorAnalysis?.revision === 1), 'pre-save version is recoverable');
    const reopened = await executeTool('read_clipmentor_analysis', { view: 'current_copy', unitId: 'U', copyPart: 'candidate' }, { ...ctx, getDoc: () => saved! }) as any;
    assert.equal(reopened.analysis.current_copy[0].candidate.lines[0].narration_ms, 'Dia tunjuk tangan.');
    assert.equal((await checkCopyProduction(saved!, null)).allowed, false, 'reopening cannot inherit a production approval');
    // A concurrent revision cannot be overwritten by a checkpoint from an old run base.
    const staleRun = await startAgentRun({ projectId, userInput: 'stale checkpoint check', askOnly: false });
    renderToString(createElement(Harness));
    await callbacks.onRunStart({ ...input, runId: staleRun.runId });
    await assert.rejects(callbacks.onToolAction({ ...action, runId: staleRun.runId }), /Project changed/);
    assert.equal((await loadProject(projectId))?.clipMentorAnalysis?.revision, 3);
    await callbacks.onTerminal({ runId: staleRun.runId, status: 'failed', assistantText: 'stale write refused' });
    // Local save failure must report failure and leave the candidate unapplied.
    current = base; await saveProject(projectId, base);
    const failedRun = await startAgentRun({ projectId, userInput: 'save failure check', askOnly: false });
    renderToString(createElement(Harness));
    await callbacks.onRunStart({ ...input, runId: failedRun.runId });
    const enqueue = projectSaveCoordinator.enqueue;
    projectSaveCoordinator.enqueue = async () => ({ projectId, revision: 0, epoch: 0, status: 'failed', saved: false, indexUpdated: false });
    try { await assert.rejects(callbacks.onToolAction({ ...action, runId: failedRun.runId }), /could not be saved/); }
    finally { projectSaveCoordinator.enqueue = enqueue; }
    assert.equal(current.clipMentorAnalysis?.revision, 1);
    assert.equal((await loadProject(projectId))?.clipMentorAnalysis?.revision, 1);
    const failedJournal = await loadServerRunDraft(projectId, failedRun.runId);
    assert(failedJournal?.tools.find(t => t.toolCallId === action.toolCallId)?.error, 'storage failure must replace the successful journal result');
    await callbacks.onTerminal({ runId: failedRun.runId, status: 'failed', assistantText: 'storage failure refused' });
    const mixedRun = await startAgentRun({ projectId, userInput: 'no media checkpoint check', askOnly: false });
    renderToString(createElement(Harness));
    await callbacks.onRunStart({ ...input, runId: mixedRun.runId });
    const mixed = structuredClone(candidate.getDoc()); mixed.timelines[0].name = 'must not be persisted';
    await assert.rejects(callbacks.onToolAction({ ...action, runId: mixedRun.runId, actions: [{ type: 'tl.setDoc', doc: mixed }] }), /analysis-only/);
    assert.equal((await loadProject(projectId))?.timelines[0].name, 'untouched');
    await callbacks.onTerminal({ runId: mixedRun.runId, status: 'failed', assistantText: 'mixed edits refused' });
    // A checkpoint must retain the exact live base for later persistent asset saves.
    current = base; await saveProject(projectId, base);
    const assetRun = await startAgentRun({ projectId, userInput: 'candidate then asset', askOnly: false });
    renderToString(createElement(Harness));
    await callbacks.onRunStart({ ...input, runId: assetRun.runId });
    await callbacks.onToolAction({ ...action, runId: assetRun.runId });
    await callbacks.onToolAction({ ...action, runId: assetRun.runId, toolCallId: 'asset-after-checkpoint', name: 'import_assets', args: {},
      result: { ok: true }, actions: [{ type: 'addAsset', asset: { id: 'prepared-audio', kind: 'audio', name: 'synthetic', src: '/mock.wav', durationInFrames: 30 } }] });
    await callbacks.onTerminal({ runId: assetRun.runId, status: 'completed', assistantText: 'preparation and asset saved' });
    assert((await loadProject(projectId))?.assets.some(a => a.id === 'prepared-audio'), 'checkpoint must not create a false concurrent edit');
    assert.equal(current.clipMentorAnalysis?.revision, 2);
    assert.deepEqual(current.timelines, base.timelines);
    // The new ledger checkpoint cannot commit an earlier timeline draft.
    current = base; await saveProject(projectId, base);
    const mixedLedgerRun = await startAgentRun({ projectId, userInput: 'pending edit then ledger checkpoint', askOnly: false });
    renderToString(createElement(Harness));
    await callbacks.onRunStart({ ...input, runId: mixedLedgerRun.runId });
    const timelineDraft = makeDraft(base); timelineDraft.commands.renameTimeline('tl', 'pending editing');
    await callbacks.onToolAction({ ...action, runId: mixedLedgerRun.runId, toolCallId: 'pending-timeline', name: 'manage_timelines',
      args: { action: 'update' }, result: { ok: true }, actions: timelineDraft.takeActions() });
    const pendingAnalysis = structuredClone(timelineDraft.getDoc()); pendingAnalysis.clipMentorAnalysis!.revision = 2;
    const mixedLedgerAction = { ...action, runId: mixedLedgerRun.runId, toolCallId: 'blocked-ledger-checkpoint',
      args: { action: 'set_source_breakdown', expectedRevision: 1 }, actions: [{ type: 'tl.setDoc' as const, doc: pendingAnalysis }] };
    await assert.rejects(callbacks.onToolAction(mixedLedgerAction), /preparation-only/);
    const mixedJournal = await loadServerRunDraft(projectId, mixedLedgerRun.runId);
    assert(!mixedJournal?.tools.some(tool => tool.toolCallId === mixedLedgerAction.toolCallId), 'refused ledger checkpoint cannot be journaled as success');
    await callbacks.onTerminal({ runId: mixedLedgerRun.runId, status: 'failed', assistantText: 'mixed transaction refused' });
    assert.deepEqual((await loadProject(projectId))?.timelines, base.timelines, 'refused checkpoint cannot commit an earlier edit');
    assert.equal((await loadProject(projectId))?.clipMentorAnalysis?.revision, 1);
    // Formal source registration and current candidate are independently durable
    // preparation checkpoints in the SAME host run, not incompatible pending edits.
    current = base; await saveProject(projectId, base);
    const pendingRun = await startAgentRun({ projectId, userInput: 'source then candidate', askOnly: false });
    renderToString(createElement(Harness));
    const pendingInput = { ...input, runId: pendingRun.runId };
    await callbacks.onRunStart(pendingInput);
    const ledgerDraft = makeDraft(base);
    const ledgerArgs = { action: 'set_source_breakdown', expectedRevision: 1, record: structuredClone(base.clipMentorAnalysis!.source_breakdown), actor,
      reason: 'Persist the formal mapping before the candidate in one preparation run' };
    const ledgerResult = await executeTool('revise_clipmentor_analysis', ledgerArgs,
      { ...ctx, commands: ledgerDraft.commands, getDoc: ledgerDraft.getDoc, getState: ledgerDraft.getState });
    assert.equal((ledgerResult as any).ok, true, JSON.stringify(ledgerResult));
    await callbacks.onToolAction({ ...action, runId: pendingRun.runId, toolCallId: 'source-checkpoint', args: ledgerArgs,
      result: ledgerResult, actions: ledgerDraft.takeActions() });
    assert.equal((await loadProject(projectId))?.clipMentorAnalysis?.revision, 2, 'formal mapping must be durable before the next preparation tool');
    const copyDraft = makeDraft(current);
    const nextArgs = { action: 'set_copy_candidate', id: 'U', expectedRevision: 2, actor, reason: 'Register the current candidate after formal source mapping',
      record: { source_candidate_id: 'script_candidate_old', candidate_id: 'script_candidate_new', plan_id: 'picture_plan_new',
        lines: (candidate.getDoc().clipMentorAnalysis!.blueprint[0] as any).internal_review.script_candidate_new.lines,
        plan: { phases: [{ line_id: 'L', source_seconds: [59, 62], picture: 'existing normal-speed range' }] }, line_guidance: 'existing plan, pending' } };
    const nextResult = await executeTool('revise_clipmentor_analysis', nextArgs,
      { ...ctx, commands: copyDraft.commands, getDoc: copyDraft.getDoc, getState: copyDraft.getState });
    assert.equal((nextResult as any).ok, true, JSON.stringify(nextResult));
    await callbacks.onToolAction({ ...action, runId: pendingRun.runId, toolCallId: 'candidate-after-source', args: nextArgs,
      result: nextResult, actions: copyDraft.takeActions() });
    assert.equal((await loadProject(projectId))?.clipMentorAnalysis?.revision, 3);
    const readback = await executeTool('read_clipmentor_analysis', { view: 'current_copy', unitId: 'U' }, { ...ctx, getDoc: () => current }) as any;
    assert.equal(readback.revision, 3);
    assert.equal(readback.analysis.current_copy[0].candidate_id, 'script_candidate_new');
    assert.equal(readback.analysis.current_copy[0].picture_plan_id, 'picture_plan_new');
    assert.deepEqual(current.clipMentorAnalysis!.source_breakdown, ledgerArgs.record, 'formal mapping is not overwritten by the candidate checkpoint');
    assert(current.clipMentorAnalysis!.audit.some(entry => entry.action === 'set_source_breakdown'));
    assert(current.clipMentorAnalysis!.audit.some(entry => entry.action === 'set_copy_candidate'));
    const staleLedger = await executeTool('revise_clipmentor_analysis', ledgerArgs, { ...ctx, getDoc: () => current }) as any;
    assert(staleLedger.error, 'stale revision cannot overwrite either checkpoint');
    assert.equal(current.clipMentorAnalysis!.revision, 3);
    assert.deepEqual((await loadProject(projectId))?.timelines, base.timelines, 'preparation cannot commit or change timeline placement');
    renderToString(createElement(Harness));
    const restored = await callbacks.onRunStart({ ...pendingInput, resumed: true });
    assert.equal(restored.draftDoc?.clipMentorAnalysis?.revision, 3);
    assert.equal(restored.baseDoc?.clipMentorAnalysis?.revision, 3);
    assert.equal((await checkCopyProduction(current, null)).allowed, false, 'successful state synchronization never grants a semantic approval');
    for (const exportName of ['submit_render_job', 'submit_export']) {
      const unapprovedExport = await executeTool(exportName, { format: 'video' }, { ...ctx, getAgentRunId: () => pendingRun.runId }) as any;
      assert.equal(unapprovedExport.production_gate?.allowed, false, 'a committed but unapproved preparation cannot bypass the existing production gate');
    }

    await callbacks.onTerminal({ runId: pendingRun.runId, status: 'failed', assistantText: 'later failure must preserve preparation checkpoints' });
    assert.equal((await loadProject(projectId))?.clipMentorAnalysis?.revision, 3);
    // Real host terminal settlement: a committed edit is not part of the
    // next run's transaction. A failed later run rolls back ONLY its draft.
    const committedBase = structuredClone(base); delete committedBase.clipMentorAnalysis;
    committedBase.timelines[0].name = 'committed editing';
    const edit = makeDraft(committedBase);
    edit.commands.addTextClip({ text: 'committed title', durationInFrames: 30 });
    current = edit.getDoc(); await saveProject(projectId, current);
    const committedBytes = JSON.stringify(await loadProject(projectId));
    const exportRun = await startAgentRun({ projectId, userInput: 'separate export failure', askOnly: false });
    renderToString(createElement(Harness));
    await callbacks.onRunStart({ ...input, runId: exportRun.runId, baseDoc: current });
    const { execExportTool } = await import('../agent/tools/export-tools');
    const draftFetch = globalThis.fetch;
    let exports = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/export/job') { exports++; return Response.json({ error: 'injected encoder failure' }, { status: 500 }); }
      return draftFetch(url, init);
    };
    try {
      const failure = await execExportTool('submit_render_job', {}, { ...ctx, getAgentRunId: () => exportRun.runId }) as any;
      assert.match(failure.error, /injected encoder failure/);
      await callbacks.onToolAction({ ...action, runId: exportRun.runId, toolCallId: 'export-failed', name: 'submit_render_job', args: {}, error: failure.error, result: undefined, actions: [] });
      await callbacks.onTerminal({ runId: exportRun.runId, status: 'failed', assistantText: 'export failed once' });
      assert.equal(exports, 1, 'no automatic external retry');
      assert.equal(JSON.stringify(await loadProject(projectId)), committedBytes, 'failed export settlement must preserve the prior committed sequence');
      assert.equal(JSON.stringify(current), committedBytes);
    } finally { globalThis.fetch = draftFetch; }
    const uncommittedRun = await startAgentRun({ projectId, userInput: 'atomic failed edit', askOnly: false });
    renderToString(createElement(Harness));
    await callbacks.onRunStart({ ...input, runId: uncommittedRun.runId, baseDoc: current });
    const pendingEdit = makeDraft(current); pendingEdit.commands.addTextClip({ text: 'must roll back', durationInFrames: 30 });
    await callbacks.onToolAction({ ...action, runId: uncommittedRun.runId, toolCallId: 'uncommitted-edit', name: 'add_text', args: {}, result: { ok: true }, actions: pendingEdit.takeActions() });
    await callbacks.onTerminal({ runId: uncommittedRun.runId, status: 'failed', assistantText: 'uncommitted transaction failed' });
    assert.equal(JSON.stringify(await loadProject(projectId)), committedBytes, 'uncommitted edits remain atomic; do not partially commit as an export workaround');
    assert.equal(JSON.stringify(current), committedBytes);
    assert.equal(realReviewCalls, 0, 'only local stub endpoints, no real model/review/TTS/render');
  } finally { globalThis.fetch = previousFetch; checkpointStore.restore(); }
}
