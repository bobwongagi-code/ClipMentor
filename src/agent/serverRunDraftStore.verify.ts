import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import type { ProjectDoc } from '../editor/types.ts';
import { migrateProjectDoc } from '../persist/projectStore.ts';
import {
  agentArtifactKey,
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
  resetAgentRuntimeStoreMemory,
  storeAgentArtifact,
  mutate,
  sha256Text,
} from '../persist/agentRuntimeStore.ts';
import { kvKeys, kvSet } from '../persist/sharedKv.ts';
import { startAgentRun } from './runtime-ledger.ts';
import { loadServerRunDraft, saveServerRunDraftBase, saveServerRunDraftTool } from './serverRunDraftStore.ts';
import { isPermanentServerRunRecoveryError } from './serverRunRecovery.ts';

// The draft endpoint is server-side; emulate it with a local artifact write.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/draft/clear') && init?.method === 'POST') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/draft') && init?.method === 'POST') {
    if (url.includes('draft-cap-403')) return new Response('{}', { status: 403 });
    if (url.includes('draft-gone-404')) return new Response('{}', { status: 404 });
    if (url.includes('draft-other-500')) return new Response('{}', { status: 500 });
    const body = JSON.parse(String(init.body)) as {
      projectId: string; artifact: Record<string, unknown>;
    };
    const a = body.artifact;
    const accepted = await storeAgentArtifact({
      version: 1,
      artifactId: String(a.artifactId),
      projectId: body.projectId,
      runId: String(url).split('/').filter(Boolean).at(-2) ?? '',
      kind: 'server-run-draft',
      bodySha256: String(a.bodySha256),
      originalBytes: Number(a.originalBytes),
      originalChars: Number(a.originalChars),
      createdAt: Date.now(),
      redacted: a.redacted === true,
      binaryOmitted: a.binaryOmitted === true,
      body: String(a.body),
      ...(typeof a.toolCallId === 'string' ? { toolCallId: a.toolCallId } : {}),
      ...(typeof a.toolName === 'string' ? { toolName: a.toolName } : {}),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: accepted ? 200 : 409, headers: { 'Content-Type': 'application/json' },
    });
  }
  return originalFetch(input, init);
}) as typeof fetch;

const projectId = `server-run-draft-privacy-${Date.now()}`;
resetAgentRuntimeStoreMemory();
const recorder = await startAgentRun({
  projectId,
  userInput: 'download private media',
  askOnly: false,
});
await saveServerRunDraftTool(projectId, recorder.runId, {
  toolCallId: 'call-private-download',
  argsDigest: 'digest-private-download',
  name: 'download_media',
  args: {
    url: 'https://s3.example/private.mp4?X-Amz-Credential=AKIA_TEST&X-Amz-Signature=aws-secret&X-Amz-Expires=900',
    nested: { apiKey: 'nested-secret' },
    azure: 'https://blob.example/private.mp4?sv=2024-01-01&se=2030-01-01&sp=r&sig=azure-secret',
    gcs: 'https://storage.example/private.mp4?X-Goog-Credential=test&X-Goog-Signature=gcs-secret',
  },
  error: 'Authorization: Bearer tool-error-secret',
  actions: [],
});
const sidecar = await loadAgentRuntimeSidecar(projectId);
const index = sidecar.artifacts.find((artifact) => artifact.kind === 'server-run-draft');
assert(index, 'server-run recovery draft is indexed');
assert.equal(index.redacted, true);
assert.equal(index.binaryOmitted, false);
const artifact = await loadAgentArtifact(projectId, index.artifactId);
assert(artifact, 'server-run recovery draft body is readable');
assert.doesNotMatch(
  artifact.body,
  /AKIA_TEST|aws-secret|nested-secret|azure-secret|gcs-secret|tool-error-secret/,
);
assert.match(artifact.body, /\[REDACTED\]/);
const body = JSON.parse(artifact.body) as {
  args: { nested: { apiKey: string }; url: string; azure: string; gcs: string };
  error: string;
};
assert.equal(body.args.nested.apiKey, '[REDACTED]');
assert.match(body.args.url, /X-Amz-Signature=\[REDACTED\]/);
assert.match(body.args.azure, /sig=\[REDACTED\]/);
assert.match(body.args.gcs, /X-Goog-Signature=\[REDACTED\]/);
assert.match(body.error, /\[REDACTED\]/);
await recorder.finalize('interrupted', 'privacy verifier complete');

// Admission and recovery may both submit the same base before the browser's
// sidecar cache sees the server write. Retrying must not poison later recovery.
const baseRecorder = await startAgentRun({ projectId, userInput: 'base recovery', askOnly: false });
const baseDoc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: 'base-timeline',
  timelines: [{ id: 'base-timeline', name: 'Base', order: 0, fps: 30, width: 1080, height: 1920, items: [], selectedId: null }],
};
const baseInput = { text: 'base recovery', content: 'base recovery', askOnly: false, references: [], baseDoc };
await Promise.all([
  saveServerRunDraftBase(projectId, baseRecorder.runId, baseInput),
  saveServerRunDraftBase(projectId, baseRecorder.runId, baseInput),
]);
const baseIndexes = (await loadAgentRuntimeSidecar(projectId)).artifacts
  .filter((item) => item.runId === baseRecorder.runId && item.toolName === 'server_run_draft_base');
assert.equal(baseIndexes.length, 1, 'identical concurrent base writes retain one canonical snapshot');
await assert.rejects(saveServerRunDraftBase(projectId, baseRecorder.runId, { ...baseInput, content: 'conflicting base' }), /HTTP 409/);
assert.equal((await kvKeys()).filter((key) => key.startsWith(agentArtifactKey(projectId, ''))).length,
  (await loadAgentRuntimeSidecar(projectId)).artifacts.length, 'deduplicated and rejected base writes leave no orphan bodies');
const baseArtifact = await loadAgentArtifact(projectId, baseIndexes[0].artifactId);
assert(baseArtifact);

// Seed the old format directly: distinct artifact IDs with duplicate base
// bodies already exist in interrupted projects and must remain recoverable.
const seedLegacyBase = async (artifactId: string, body: string) => {
  const record = { ...baseArtifact, artifactId, body, bodySha256: await sha256Text(body),
    originalBytes: new TextEncoder().encode(body).byteLength, originalChars: body.length, createdAt: Date.now() };
  await kvSet(agentArtifactKey(projectId, artifactId), record);
  const { body: _body, version: _version, ...index } = record;
  await mutate(projectId, (current) => [{ ...current, artifacts: [...current.artifacts, index],
    runs: current.runs.map((run) => run.runId === baseRecorder.runId
      ? { ...run, artifactIds: [...run.artifactIds, artifactId] } : run) }, undefined]);
};
await seedLegacyBase('srd_legacy_same', baseArtifact.body);
await saveServerRunDraftTool(projectId, baseRecorder.runId, {
  toolCallId: 'saved-analysis', argsDigest: 'analysis-digest', name: 'revise_clipmentor_analysis',
  args: {}, result: { ok: true, revision: 12 }, actions: [],
});
const recoveredDraft = await loadServerRunDraft(projectId, baseRecorder.runId);
assert.deepEqual(recoveredDraft?.base.baseDoc, migrateProjectDoc(baseDoc), 'identical historical bases recover the same normalized project');
assert.equal(recoveredDraft?.tools.length, 1, 'historical duplicate bases do not duplicate saved tool actions');
assert.deepEqual(recoveredDraft?.tools[0].result, { ok: true, revision: 12 }, 'recovery retains the latest saved tool result');
await seedLegacyBase('srd_legacy_conflict', JSON.stringify({ ...JSON.parse(baseArtifact.body), content: 'conflicting base' }));
await assert.rejects(loadServerRunDraft(projectId, baseRecorder.runId), (error: unknown) =>
  isPermanentServerRunRecoveryError(error) && error instanceof Error && /conflicting base/.test(error.message),
  'conflicting historical bases fail closed without an infinite transient retry');
await baseRecorder.finalize('interrupted', 'base recovery verifier complete');

// Error hints carry the real reason (the bare 'could not be persisted' hid
// the capability loss after tab switches/reloads).
{
  const { saveServerRunDraftBase } = await import('./serverRunDraftStore');
  const expectHint = async (runId: string, pattern: RegExp) => {
    await assert.rejects(
      saveServerRunDraftBase('project', runId, { text: 't', content: 'c', askOnly: false, references: [], baseDoc: {} as never }),
      (error: unknown) => error instanceof Error && pattern.test(error.message),
    );
  };
  await expectHint('draft-cap-403', /run capability was lost/);
  await expectHint('draft-gone-404', /no longer exists on the server/);
  await expectHint('draft-other-500', /HTTP 500/);
}

console.log('serverRunDraftStore.verify: privacy, idempotent bases, historical duplicates and conflict refusal passed');
