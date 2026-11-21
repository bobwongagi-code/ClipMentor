import assert from 'node:assert/strict';
import { createExportJobStore } from '../../export/backgroundExportStore';
import {
  agentExportMediaPoolState,
  saveTrackedAgentExport,
  subscribeAgentExportJobs,
} from '../../export/agentExportTracking';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execExportTool, __resetExportSessionJobs, fetchRenderJob } from './export-tools';
import { execExportQaTool } from './export-qa-tools';
import { execMgVideoTool } from './mg-video-tools';
import { execReadProjectTool } from './read-project-tools';

const sourceAsset = {
  id: 'source-long',
  name: 'long-live.mp4',
  kind: 'video' as const,
  src: '/media/uploads/long-live.mp4',
  durationInFrames: 18_000,
  width: 1920,
  height: 1080,
};
const project = docFromTimeline({
  fps: 30,
  width: 1080,
  height: 1920,
  selectedId: null,
  assets: [sourceAsset],
  items: [{
    id: 'source-range',
    name: '产品痛点',
    kind: 'video',
    track: 'V1',
    src: sourceAsset.src,
    sourceAssetId: sourceAsset.id,
    startFrame: 0,
    durationInFrames: 90,
    srcInFrame: 300,
    playbackRate: 2,
  }],
});
project.timelines[0] = { ...project.timelines[0]!, id: 'clip-01', name: '01-产品痛点-3秒-9:16' };
project.activeTimelineId = 'clip-01';
const draft = makeDraft(project);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getProjectId: () => 'project-clips',
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
const storage = new Map<string, string>([[
  'cc.serverRun.project-clips',
  JSON.stringify({ projectId: 'project-clips', runId: 'run-save' }),
]]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});
const store = createExportJobStore();
const unsubscribe = subscribeAgentExportJobs(
  'project-clips',
  store,
  (message) => message,
  { commands: draft.commands, getDoc: draft.getDoc },
);

async function verifyReplacementIsNeverDelivered(): Promise<void> {
  __resetExportSessionJobs();
  const fixture = makeDraft(project);
  const owner: AgentContext = { ...ctx, commands: fixture.commands, getDoc: fixture.getDoc, getState: fixture.getState };
  const writes: string[] = [];
  let posts = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/export/job') {
      posts++;
      return Response.json({ renderId: 'same-id', attemptId: 'original' });
    }
    if (path.includes('/promote')) {
      writes.push(path);
      return Response.json({ assetId: 'replacement', path: '/media/uploads/replacement.mp4' });
    }
    return Response.json({
      id: 'same-id', status: 'succeeded', progress: 100,
      params: { exportAttemptId: 'replacement' },
      result: { assetId: 'replacement', path: '/media/uploads/replacement-temporary.mp4' },
    });
  };
  await execExportTool('submit_render_job', { saveToMediaPool: true }, owner);
  const stale = await execExportTool('track_export', { action: 'status', renderIds: 'same-id' }, owner) as {
    error?: string; downloadUrl?: string;
  };
  assert.match(stale.error ?? '', /attempt/);
  assert.equal(stale.downloadUrl, undefined);
  assert.match((await fetchRenderJob('same-id') as { error?: string }).error ?? '', /attempt/);
  assert.deepEqual(writes, []);
  assert.equal(posts, 1);
  assert.equal(fixture.getDoc().assets.length, 1);
}

async function verifyAcceptedAttemptsKeepSeparateOutputs(): Promise<void> {
  __resetExportSessionJobs();
  const original = makeDraft(project);
  const other = makeDraft(project);
  const owner: AgentContext = { ...ctx, getProjectId: () => 'owner', commands: original.commands, getDoc: original.getDoc };
  const foreign: AgentContext = { ...ctx, getProjectId: () => 'other', commands: other.commands, getDoc: other.getDoc };
  const promoted: string[] = [];
  let attempt = 'first';
  let switchedAtPromotion = false;
  let reads = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://local');
    if (url.pathname === '/export/job') return Response.json({ renderId: 'reused', attemptId: attempt });
    assert.equal(url.searchParams.get('attemptId'), attempt);
    if (url.pathname.endsWith('/promote')) {
      assert.equal(url.searchParams.get('assetId'), `asset-${attempt}`);
      promoted.push(attempt);
      if (switchedAtPromotion) return Response.json({ error: 'render no longer matches the requested attempt' }, { status: 409 });
      return Response.json({ assetId: `asset-${attempt}`, path: `/media/uploads/published-${attempt}.mp4` });
    }
    reads++;
    return Response.json({
      id: 'reused', status: 'succeeded', progress: 100, params: { exportAttemptId: attempt },
      result: { assetId: `asset-${attempt}`, path: `/media/uploads/temporary-${attempt}.mp4` },
    });
  };
  const submit = () => execExportTool('submit_render_job', { saveToMediaPool: true }, owner);
  const status = (context: AgentContext) => execExportTool('track_export', { action: 'status', renderIds: 'reused' }, context) as
    Promise<{ mediaPoolStatus?: string; mediaAssetId?: string; error?: string }>;
  await submit();
  assert.match((await status(foreign)).error ?? '', /different project/);
  const latest = await execExportTool('track_export', { action: 'status' }, foreign) as { error?: string };
  assert.match(latest.error ?? '', /no render jobs/);
  const qa = await execExportQaTool('verify_export', { renderId: 'reused' }, foreign) as { error?: string };
  assert.match(qa.error ?? '', /different project/);
  foreign.commands.addAsset({
    id: 'mg-source', kind: 'motion-graphic', name: 'Other project title',
    code: 'export default () => null', src: 'tpl:other', durationInFrames: 30,
  });
  const mg = await execMgVideoTool('register_converted_video', { renderId: 'reused', mgAssetId: 'mg-source' }, foreign) as { error?: string };
  assert.match(mg.error ?? '', /different project/);
  assert.equal(reads, 0, 'foreign lookup, QA and conversion must stop before reading the owner output');
  assert.deepEqual(promoted, []);
  assert.equal(other.getDoc().assets.length, 2, 'only the source motion graphic was added');
  assert.equal((await status(owner)).mediaAssetId, 'asset-first');
  attempt = 'second';
  await submit();
  assert.equal((await status(owner)).mediaAssetId, 'asset-second');
  assert.deepEqual(original.getDoc().assets.map((asset) => asset.id), ['source-long', 'asset-first', 'asset-second']);
  assert.deepEqual(promoted, ['first', 'second']);
  attempt = 'third';
  switchedAtPromotion = true;
  await submit();
  assert.equal((await status(owner)).mediaPoolStatus, 'failed');
  assert.equal(original.getDoc().assets.length, 3, 'a change between status and promotion cannot add a different output');
}

async function verifySharedPromotion(mode: 'keep' | 'detach' | 'detached-error' | 'attached-error'
  | 'cancel' | 'discarded-draft' | 'cancel-with-draft'): Promise<void> {
  __resetExportSessionJobs();
  const fixture = makeDraft(project);
  const controller = new AbortController();
  const owner: AgentContext = {
    ...ctx, getProjectId: () => 'promotion-project', getAgentRunSignal: () => controller.signal,
    commands: fixture.commands, getDoc: fixture.getDoc,
  };
  const jobs = createExportJobStore();
  const detach = subscribeAgentExportJobs('promotion-project', jobs, (key) => key, {
    commands: fixture.commands, getDoc: fixture.getDoc,
  });
  const promotionStarted = Promise.withResolvers<void>();
  const finishPromotion = Promise.withResolvers<void>();
  const foregroundPolled = Promise.withResolvers<void>();
  let pendingSignal: AbortSignal | null | undefined;
  let reads = 0;
  let promotions = 0;
  const savedOutput = { assetId: 'shared-output', path: '/media/uploads/published-shared.mp4' };
  const cancelled = mode === 'cancel' || mode === 'cancel-with-draft';
  const detachEditor = mode === 'detach' || mode === 'detached-error' || mode === 'discarded-draft';
  try {
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path === '/export/job') return Response.json({ renderId: 'shared', attemptId: 'same-attempt' });
      if (path.includes('/promote?')) {
        promotions += 1;
        pendingSignal = init?.signal;
        promotionStarted.resolve();
        await finishPromotion.promise;
        return (mode === 'detached-error' || mode === 'attached-error') && promotions === 1
          ? Response.json({ error: 'promotion receipt unavailable' }, { status: 503 })
          : Response.json(savedOutput);
      }
      assert.equal(path, '/export/job/shared?attemptId=same-attempt');
      if (++reads === 2) foregroundPolled.resolve();
      return Response.json({
        id: 'shared', status: 'succeeded', progress: 100, params: { exportAttemptId: 'same-attempt' },
        result: { assetId: 'shared-output', path: '/media/uploads/temporary-shared.mp4' },
      });
    };
    await execExportTool('submit_render_job', { saveToMediaPool: true }, owner);
    await promotionStarted.promise;
    const waiting = execExportTool('track_export', { action: 'wait', renderIds: 'shared' }, owner);
    await foregroundPolled.promise;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    assert.equal(promotions, 1, 'two in-flight callers must share the promotion');
    controller.abort();
    assert.equal((await waiting as { waitCancelled?: boolean }).waitCancelled, true);
    assert.equal(pendingSignal?.aborted, false, 'a foreground stop cannot abort the live editor consumer');
    if (mode === 'cancel') assert.equal(jobs.cancel(jobs.getSnapshot().jobs[0]!.id), true);
    if (mode === 'discarded-draft' || mode === 'cancel-with-draft') {
      const agentDraft = makeDraft(project);
      const saveDraft = () => saveTrackedAgentExport({
        renderId: 'shared', attemptId: 'same-attempt', projectId: 'promotion-project',
      }, savedOutput, { commands: agentDraft.commands, getDoc: agentDraft.getDoc, draft: true }, new AbortController().signal);
      const saved = saveDraft();
      if (cancelled) assert.equal(jobs.cancel(jobs.getSnapshot().jobs[0]!.id), true);
      detach();
      finishPromotion.resolve();
      await saved;
      if (cancelled) await saveDraft();
      assert.equal(agentDraft.getDoc().assets.length, cancelled ? 1 : 2);
      assert.equal(agentExportMediaPoolState('shared', 'same-attempt')?.status, cancelled ? 'failed' : 'saved');
    } else if (detachEditor || cancelled) detach();
    finishPromotion.resolve();
    for (let tick = 0; tick < 50 && jobs.getActiveCount(); tick++) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    }
    assert.equal(jobs.getActiveCount(), 0);
    const phase = cancelled ? 'cancelled' : mode === 'attached-error' ? 'failed' : 'completed';
    assert.equal(jobs.getSnapshot().jobs[0]?.progress.phase, phase,
      'a detached media pool must not make a completed render look like a render failure');
    if (mode === 'attached-error') {
      assert.equal(jobs.getSnapshot().jobs[0]?.failure?.stage, 'destination');
      assert.match(jobs.getSnapshot().jobs[0]?.error ?? '', /promotion receipt unavailable/);
    }
    assert.equal(fixture.getDoc().assets.length, mode === 'keep' ? 2 : 1);
    if (detachEditor || cancelled) {
      const foreignJobs = createExportJobStore();
      const detachForeign = subscribeAgentExportJobs('other-project', foreignJobs, (key) => key);
      assert.equal(foreignJobs.getSnapshot().jobs.length, 0);
      detachForeign();
      const reopened = createExportJobStore();
      const detachReopened = subscribeAgentExportJobs('promotion-project', reopened, (key) => key, {
        commands: fixture.commands, getDoc: fixture.getDoc,
      });
      try {
        assert.equal(reopened.getSnapshot().jobs.length, cancelled ? 0 : 1,
          'reopening reattaches pending registrations and respects an explicit cancel');
        for (let tick = 0; tick < 50 && reopened.getActiveCount(); tick++) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
        }
        assert.equal(reopened.getSnapshot().jobs[0]?.progress.phase, cancelled ? undefined : 'completed');
        assert.equal(fixture.getDoc().assets.length, cancelled ? 1 : 2);
        assert.equal(promotions, mode === 'detached-error' ? 2 : 1, 'reopening reuses a publication unless its receipt failed');
      } finally {
        detachReopened();
      }
    }
  } finally {
    finishPromotion.resolve();
    detach();
  }
}

async function verifyTerminalFailureDoesNotRequeue(): Promise<void> {
  __resetExportSessionJobs();
  const owner: AgentContext = { ...ctx, getProjectId: () => 'failed-export-owner' };
  const jobs = createExportJobStore();
  const detach = subscribeAgentExportJobs('failed-export-owner', jobs, (key) => key);
  let reads = 0;
  try {
    globalThis.fetch = async (input) => {
      if (String(input) === '/export/job') return Response.json({ renderId: 'terminal-failure', attemptId: 'failed-attempt' });
      assert.equal(String(input), '/export/job/terminal-failure?attemptId=failed-attempt');
      reads++;
      return Response.json({
        id: 'terminal-failure', progress: 100, status: 'failed',
        params: { exportAttemptId: 'failed-attempt' }, error: 'renderer stopped',
      });
    };
    await execExportTool('submit_render_job', { saveToMediaPool: true }, owner);
    for (let tick = 0; tick < 50 && jobs.getActiveCount(); tick++) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    }
    assert.equal(jobs.getSnapshot().jobs[0]?.progress.phase, 'failed');
    detach();
    const reopened = createExportJobStore();
    const close = subscribeAgentExportJobs('failed-export-owner', reopened, (key) => key);
    try {
      assert.equal(reopened.getSnapshot().jobs.length, 0);
      assert.equal(reads, 1, 'a known terminal render is not polled again on reopen');
    } finally {
      close();
    }
  } finally {
    detach();
  }
}

try {
  await verifyReplacementIsNeverDelivered();
  await verifyAcceptedAttemptsKeepSeparateOutputs();
  for (const mode of ['keep', 'detach', 'detached-error', 'attached-error', 'cancel', 'discarded-draft', 'cancel-with-draft'] as const) {
    await verifySharedPromotion(mode);
  }
  await verifyTerminalFailureDoesNotRequeue();
  __resetExportSessionJobs();
  let promotions = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target === '/export/job' && init?.method === 'POST') {
      return Response.json({ renderId: 'render-save', attemptId: 'attempt-save' });
    }
    if (target === '/export/job/render-save?attemptId=attempt-save' && (!init?.method || init.method === 'GET')) {
      return Response.json({
        id: 'render-save',
        status: 'succeeded',
        progress: 100,
        params: { exportAttemptId: 'attempt-save' },
        result: {
          assetId: 'derived-video',
          path: '/media/uploads/openchatcut-export-job-derived-video.mp4',
          name: '01-产品痛点.mp4',
          durationSeconds: 3,
          width: 1080,
          height: 1920,
          sizeBytes: 1024,
          sourceStartSeconds: 0,
        },
      });
    }
    if (target === '/export/job/render-save/promote?attemptId=attempt-save&assetId=derived-video' && init?.method === 'POST') {
      promotions++;
      return Response.json({
        assetId: 'derived-video',
        path: '/media/uploads/openchatcut-derived-derived-video.mp4',
        name: '01-产品痛点.mp4',
        durationSeconds: 3,
        width: 1080,
        height: 1920,
        sizeBytes: 1024,
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  }) as typeof fetch;

  const submitted = await execExportTool('submit_render_job', {
    format: 'video',
    name: '01-产品痛点.mp4',
    saveToMediaPool: true,
  }, ctx) as { ok?: boolean; renderId?: string; mediaPoolStatus?: string };
  assert.equal(submitted.ok, true);
  assert.equal(submitted.renderId, 'render-save');
  assert.equal(submitted.mediaPoolStatus, 'pending');

  const tracked = await execExportTool('track_export', {
    action: 'wait',
    renderIds: 'render-save',
  }, ctx) as { mediaPoolStatus?: string; mediaAssetId?: string };
  assert.equal(tracked.mediaPoolStatus, 'saved');
  assert.equal(tracked.mediaAssetId, 'derived-video');
  assert.equal(agentExportMediaPoolState('render-save', 'attempt-save')?.status, 'saved');
  const actions = draft.takeActions();
  assert.equal(actions.filter((action) => action.type === 'addAsset').length, 1,
    'track_export must capture the derived asset in the Agent draft ledger');
  draft.commands.applyDoc(project);
  draft.takeActions();
  assert.equal(draft.getDoc().assets.length, 1, 'simulate a proposal commit that replaced the live document');
  storage.delete('cc.serverRun.project-clips');
  const savedJob = () => store.getSnapshot().jobs.find((job) => job.label === '01-产品痛点.mp4');
  for (let attempt = 0; attempt < 50 && savedJob()?.progress.phase !== 'completed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(savedJob()?.progress.phase, 'completed', savedJob()?.error ?? undefined);
  assert.equal(promotions, 1, 'foreground and background consumers share exactly one promotion');

  const assets = draft.getDoc().assets;
  assert.equal(assets.length, 2, 'the source stays referenced and one derived asset is registered');
  const saved = assets.find((asset) => asset.id === 'derived-video');
  assert.equal(saved?.src, '/media/uploads/openchatcut-derived-derived-video.mp4');
  assert.deepEqual(saved?.props?.openchatcutDerivedFrom, {
    kind: 'sequence-export',
    timelineId: 'clip-01',
    timelineName: '01-产品痛点-3秒-9:16',
    renderId: 'render-save',
    sourceAssetIds: ['source-long'],
    sourceRanges: [{
      itemId: 'source-range',
      sourceAssetId: 'source-long',
      timelineStartFrame: 0,
      timelineEndFrameExclusive: 90,
      sourceStartFrame: 300,
      sourceEndFrameExclusive: 480,
    }],
  });

  const read = await execReadProjectTool('read_project', { view: 'assets', assetId: 'derived-video' }, ctx) as {
    mediaPool?: { assets?: Array<{ derivedFrom?: unknown }> };
  };
  assert.deepEqual(read.mediaPool?.assets?.[0]?.derivedFrom, saved?.props?.openchatcutDerivedFrom);
} finally {
  unsubscribe();
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

console.log('agent export media-pool checks passed');
