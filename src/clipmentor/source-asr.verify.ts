import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeDraft } from '../editor/store';
import { migrateProjectDoc, createProject, saveProject, loadProject, resetProjectStoreMemory } from '../persist/projectStore';
import { saveVersion, listVersions } from '../persist/versionStore';
import { buildProjectExport, importProjectPackage, PROJECT_EXPORT_FORMAT } from '../persist/projectTransfer';
import { putMediaBlob, resetMediaBlobMemory } from '../persist/mediaBlobStore';
import { executeTool } from '../agent/tools';
import type { AgentContext } from '../agent/context';
import type { ProjectDoc } from '../editor/types';
import { ASR_AUDIO, FUNASR_MODEL, type SourceTranscription } from '../../shared/clipmentor-asr';
import { checkAnalysisHandoff, isClipMentorAnalysis } from './analysis';

const media = new TextEncoder().encode('synthetic original master');
const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', media))].map((x) => x.toString(16).padStart(2, '0')).join('');
const base: ProjectDoc = { version: 3, assets: [{ id: 'source', name: 'source', kind: 'video', src: '/media/uploads/asr-test.mp4', sourceSize: media.length, durationInFrames: 300 }], mediaFolders: [],
  timelines: [{ id: 'tl', name: 'Unchanged', order: 0, fps: 30, width: 576, height: 1024, items: [], selectedId: null, tracks: { v1: { kind: 'video' } }, trackOrder: ['v1'] }], activeTimelineId: 'tl' };
const actor = { operator: 'test operator', executor: 'verification', instruction: 'Test ASR only; no selling-point extraction or editing', identity: 'local_declared_not_authenticated' };
let operationId = randomUUID();
const result = (): SourceTranscription => ({ schema_version: 1, operation_id: operationId, provider: 'fun-asr', model: FUNASR_MODEL,
  requested_language: 'auto', detected_language: null, source_hash: hash, duration_seconds: 10, fps: 30, audio: ASR_AUDIO,
  status: 'completed', requests_attempted: 1, chunks: [{ chunk_id: 'chunk-1', offset_seconds: 0, end_seconds: 10, status: 'completed', audio_bytes: 3, audio_sha256: hash,
    words: [{ text: 'original', start_seconds: 0.1, end_seconds: 0.5 }], detected_language: null }],
  words: [{ text: 'original', start_seconds: 0.1, end_seconds: 0.5 }], conflicts: [], issues: [] });
const originalFetch = globalThis.fetch;
let response = result(), changeDuringCall = false, calls = 0;
let engine = makeDraft(base);
const ctx: AgentContext = { commands: engine.commands, getDoc: engine.getDoc, getState: engine.getState, getCreativeMode: () => null, templates: [], audio: [] };
const args = () => ({ assetId: 'source', operationId, maxRequests: 1, expectedRevision: 0, actor, reason: 'Test-only ASR initialization' });
const call = async () => await executeTool('transcribe_clipmentor_source', args(), ctx) as { ok?: boolean; error?: string };
try {
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(url, '/api/clipmentor/transcribe-source');
    const body = JSON.parse(String(init?.body)); assert.equal(body.language, 'auto');
    assert.equal(body.src, base.assets[0].src); assert.equal(body.sourceSize, media.length);
    assert(!('apiKey' in body));
    if (changeDuringCall) engine.commands.applyDoc({ ...engine.getDoc(), assets: [{ ...base.assets[0], src: '/media/uploads/replacement.mp4' }] });
    return Response.json(response);
  };
  assert((await call()).ok); const saved = structuredClone(engine.getDoc());
  assert.equal(saved.assets[0].sourceContentHash, hash, 'missing original master hash is supplied by server');
  assert.deepEqual(saved.timelines, base.timelines);
  assert.equal(saved.clipMentorAnalysis!.transcripts[0].words[0].start_seconds, 0.1);
  assert.equal(saved.clipMentorAnalysis!.reviews.length, 0);
  assert.equal(saved.clipMentorAnalysis!.points.length, 0);
  assert.equal(saved.clipMentorAnalysis!.evidence.length, 0, 'ASR does not invent original claims or visual evidence');
  assert.equal(saved.clipMentorAnalysis!.source_transcription!.requested_language, 'auto');
  assert.equal(saved.clipMentorAnalysis!.transcripts[0].status, 'machine_transcript_candidate_not_listening_verified');
  assert.equal((await checkAnalysisHandoff(saved)).status, 'review_required');
  assert((await call()).error); assert.equal(calls, 1, 'existing analysis blocks a second paid operation');

  engine = makeDraft(base); Object.assign(ctx, { commands: engine.commands, getDoc: engine.getDoc, getState: engine.getState });
  changeDuringCall = true; assert((await call()).error); assert(!engine.getDoc().clipMentorAnalysis); changeDuringCall = false;
  engine = makeDraft(base); Object.assign(ctx, { commands: engine.commands, getDoc: engine.getDoc, getState: engine.getState });
  operationId = randomUUID(); response = { ...result(), status: 'failed', words: [], issues: ['provider_request_failed_or_invalid_timestamps'], chunks: [{ ...result().chunks[0], status: 'failed', words: [] }] };
  assert((await call()).ok); assert.equal((await checkAnalysisHandoff(engine.getDoc())).status, 'review_required');
  assert.equal(engine.getDoc().clipMentorAnalysis!.source_transcription!.status, 'failed');
  const malformed = structuredClone(saved); (malformed.clipMentorAnalysis as unknown as Record<string, unknown>).source_transcription = { status: 'completed' };
  assert(!isClipMentorAnalysis(malformed.clipMentorAnalysis)); assert.equal(migrateProjectDoc(malformed), null);

  resetProjectStoreMemory(); resetMediaBlobMemory();
  const meta = await createProject('Synthetic source ASR test', saved); await saveProject(meta.id, saved);
  assert.deepEqual((await loadProject(meta.id))?.clipMentorAnalysis, saved.clipMentorAnalysis);
  await saveVersion(meta.id, 'ASR draft', saved);
  assert.deepEqual((await listVersions(meta.id))[0].doc.clipMentorAnalysis, saved.clipMentorAnalysis);
  await putMediaBlob(base.assets[0].src, new Blob([media], { type: 'video/mp4' }));
  globalThis.fetch = async () => new Response(media, { headers: { 'Content-Type': 'video/mp4' } });
  let importedDoc: ProjectDoc | undefined;
  const options = { publish: async (staged: { doc: ProjectDoc }) => {
    importedDoc = staged.doc; return { id: 'asr-roundtrip', name: 'asr-roundtrip', updatedAt: 1 };
  } };
  const exported = await buildProjectExport(meta.id, 'ASR draft');
  await importProjectPackage(exported.blob, options);
  assert.deepEqual(importedDoc?.clipMentorAnalysis, saved.clipMentorAnalysis);
  const legacy = new Blob([JSON.stringify({ format: PROJECT_EXPORT_FORMAT, name: 'ASR legacy', exportedAt: new Date(0).toISOString(), doc: saved,
    media: [{ src: base.assets[0].src, name: 'asr-test.mp4', mime: 'video/mp4', bytes: media.length, dataBase64: Buffer.from(media).toString('base64') }] })]);
  await importProjectPackage(legacy, options);
  assert.deepEqual(importedDoc?.clipMentorAnalysis, saved.clipMentorAnalysis);
  console.log('ClipMentor asset ASR: registered tool, stale-write guard, hash binding, no analysis inference, failures and project/version/both transfer roundtrips passed');
} finally { globalThis.fetch = originalFetch; }
