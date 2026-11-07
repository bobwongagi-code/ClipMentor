import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeTool, TOOL_SCHEMAS } from '../tools';
import { activatedToolNamesForResult } from '../skills/skill-tool-activation';
import { policyForTool } from '../execution-policy';
import { EXPORT_QA_TOOL_SCHEMAS } from './schemas/export-qa-tools';
import type { AgentContext } from '../context';
import { execExportQaTool } from './export-qa-tools';

const state = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['v1', 'a1'],
  tracks: { v1: { kind: 'video' as const }, a1: { kind: 'audio' as const } },
  items: [
    { id: 'one', track: 'v1', startFrame: 0, durationInFrames: 60, name: 'one', kind: 'video' as const, src: '/media/uploads/one.mp4' },
    { id: 'two', track: 'v1', startFrame: 60, durationInFrames: 60, name: 'two', kind: 'video' as const, src: '/media/uploads/two.mp4' },
    { id: 'audio', track: 'a1', startFrame: 0, durationInFrames: 120, name: 'audio', kind: 'audio' as const, src: '/media/uploads/audio.wav' },
  ],
};
const ctx = {
  getState: () => state,
  getDoc: () => ({ assets: [], timelines: [], activeTimelineId: 'timeline' }),
  commands: {}, templates: [], audio: [], getCreativeMode: () => null,
} as unknown as AgentContext;

const originalFetch = globalThis.fetch;
let requestBody: Record<string, unknown> = {};
let renderJobResult: Record<string, unknown> | null = null;
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('/export/job/')) {
    return new Response(JSON.stringify({
      id: 'render-custom',
      status: 'succeeded',
      progress: 100,
      result: renderJobResult,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  return new Response(JSON.stringify({
    ok: true,
    src: '/media/uploads/export.mp4',
    report: {
      ok: true,
      durationSeconds: 4,
      width: 1920,
      height: 1080,
      fps: 30,
      hasVideo: true,
      hasAudio: true,
      blackFrames: [], frozenFrames: [], silence: [],
      issues: [], summary: { errors: 0, warnings: 0 },
    },
    evidence: {
      mediaType: 'image/jpeg',
      base64: 'ZmFrZS1qcGVn',
      samples: [
        { cutSeconds: 2, sampleSeconds: 1.9, side: 'before' },
        { cutSeconds: 2, sampleSeconds: 2.1, side: 'after' },
      ],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const noNetworkFetch = globalThis.fetch;
  let localRequests = 0;
  globalThis.fetch = async () => { localRequests++; throw new Error('Local self-check must never use a service'); };
  const manifest = { fps: 30, total_frames: 120, scenes: [
    { start_frame: 0, end_frame: 90, kind: 'relation', content: [1, 2] },
    { start_frame: 90, end_frame: 96, kind: 'still', content: 2, label: 'breath' },
    { start_frame: 96, end_frame: 120, kind: 'original', content: 3 },
  ], audios: [{ start: 0, end: 3.01, kind: 'voice' }, { start: 3.21, end: 4, kind: 'original' }] };
  const before = JSON.stringify(ctx.getDoc());
  assert.deepEqual(policyForTool('verify_export', { executionManifest: manifest }), { effect: 'read', recovery: 'pure' });
  assert.notEqual(policyForTool('verify_export', { executionManifest: manifest, src: '/media/uploads/x.mp4' }).effect, 'read', 'only the data-only mode gains a pure-read classification');
  const local = await executeTool('verify_export', { executionManifest: manifest }, { ...ctx, getCreativeMode: () => 'clipmentor' }) as any;
  const invalid = await executeTool('verify_export', { executionManifest: { fps: 0 } }, { ...ctx, getCreativeMode: () => 'clipmentor' }) as any;
  assert(invalid.error);
  assert.equal(invalid.full_film_accepted, false);
  const skill = readFileSync(new URL('../skills/clipmentor/SKILL.md', import.meta.url), 'utf8');
  assert(activatedToolNamesForResult('load_skill', { contents: { 'SKILL.md': skill } }, TOOL_SCHEMAS).includes('verify_export'), 'loading ClipMentor activates the existing self-check entry');
  const catalog = JSON.parse(readFileSync(new URL('../../../assets/agent/openchatcut-tool-schemas.json', import.meta.url), 'utf8'));
  assert.deepEqual(catalog.edit.find((tool: { name: string }) => tool.name === 'verify_export').input_schema, EXPORT_QA_TOOL_SCHEMAS[0].input_schema);

  assert.equal(local.ok, true);
  assert.equal(local.transition_self_check.review_groups.length, 1);
  assert.equal(local.human_review_requested, false);
  assert.equal(local.full_film_accepted, false);
  assert.equal(localRequests, 0);
  assert.equal(JSON.stringify(ctx.getDoc()), before);
  globalThis.fetch = noNetworkFetch;

  const result = await execExportQaTool('verify_export', {
    src: '/media/uploads/export.mp4', maxCuts: 4,
  }, ctx) as {
    ok: boolean;
    cutCount: number;
    __images: { base64: string }[];
    next: string;
  };
  assert.equal(result.ok, true);
  assert.equal(result.cutCount, 1);
  assert.equal(result.__images[0]!.base64, 'ZmFrZS1qcGVn');
  assert.match(result.next, /passed/i);
  assert.equal(requestBody.durationSeconds, 4);
  assert.equal(requestBody.expectsAudio, true);
  assert.deepEqual(requestBody.cutTimesSeconds, [2]);

  const mixed = await execExportQaTool('verify_export', { src: '/media/uploads/export.mp4', executionManifest: manifest }, ctx) as any;
  assert.equal(mixed.preview_binding, 'timing_only_not_content_verified');
  assert.equal(mixed.full_film_accepted, false);
  const mismatched = await execExportQaTool('verify_export', { src: '/media/uploads/export.mp4', executionManifest: { ...manifest, fps: 25 } }, ctx) as any;
  assert.equal(mismatched.preview_binding, 'timing_mismatch');
  assert.equal(mismatched.ok, true, 'the completed report must remain readable');
  assert.equal(mismatched.qa_passed, false, 'a stale/timebase-mismatched manifest cannot masquerade as checked output');

  const technicalFetcher = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await technicalFetcher(url, init); const data = await response.json();
    if (data.report) delete data.report.fps;
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const missingTiming = await execExportQaTool('verify_export', { src: '/media/uploads/export.mp4', executionManifest: manifest }, ctx) as any;
  assert.match(missingTiming.error, /invalid or inconsistent report/, 'missing metadata must not be called matching');
  assert.notEqual(missingTiming.qa_passed, true);
  globalThis.fetch = technicalFetcher;

  renderJobResult = {
    path: '/media/uploads/ranged.mp4',
    name: 'ranged.mp4',
    codec: 'h264',
    durationSeconds: 2,
    width: 1280,
    height: 720,
    fps: 25,
    sourceStartSeconds: 2,
  };
  await execExportQaTool('verify_export', { renderId: 'render-custom' }, ctx);
  assert.equal(requestBody.durationSeconds, 2, 'render metadata overrides full timeline duration');
  assert.equal(requestBody.width, 1280, 'render metadata overrides timeline width');
  assert.equal(requestBody.height, 720, 'render metadata overrides timeline height');
  assert.equal(requestBody.fps, 25, 'render metadata overrides timeline fps');
  assert.deepEqual(requestBody.cutTimesSeconds, [], 'ranged export omits cuts outside its output span');
  console.log('export-qa-tools.check: ok');
} finally {
  globalThis.fetch = originalFetch;
}
