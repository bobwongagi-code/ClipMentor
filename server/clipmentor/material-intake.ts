import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { MediaAsset } from '../../src/editor/types';
import { revisionOf } from '../../src/agent/external-edit-session';
import { runProjectMigrations } from '../../src/persist/migrations';
import { editorCredentialAuthorized } from '../editor-auth';
import { isProjectConnected } from '../external-agent/broker';
import { commitOfflineStoredProject, loadOfflineStoredProject } from '../external-agent/offline-project-store';
import { claimOfflineProjectOwnership, releaseProjectEditOwnership } from '../external-agent/project-edit-ownership';
import { ffprobeBin } from '../media-binaries';
import { displayDimensions, rotationOf } from '../media-normalization';
import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir';
import { streamUploadToFile } from '../plugins/upload-stream';
import { withSerializedProjectStore } from '../plugins/project-store';
import { sha256File } from '../../shared/node-content-hash';
import { CLIPMENTOR_OUTPUT_CANVAS } from './production-format';
import { hasWebmDocType } from './video-input';
import { CLIPMENTOR_TASK_LIMIT } from '../../shared/clipmentor-tasks';
import { uploadFeedback, type UploadFeedbackCode } from '../../shared/clipmentor-upload-feedback';

class UploadFeedback extends Error {
  readonly reason:UploadFeedbackCode;
  constructor(reason:UploadFeedbackCode){super(uploadFeedback[reason]);this.reason=reason;}
}

const maxRequestBytes = 64 * 1024 * 1024;
const slots = ['source', 'product', 'sales', 'cta'] as const;
const allowed = { video: ['.mp4', '.mov', '.webm'], image: ['.png', '.jpg', '.jpeg', '.webp'] };
const imageFormats: Record<string, string> = { '.png': 'png_pipe', '.jpg': 'jpeg_pipe', '.jpeg': 'jpeg_pipe', '.webp': 'webp_pipe' };
const probe = promisify(execFile);
type Slot = typeof slots[number];
const receiptAssets = (entries: MediaAsset[]) => entries.map(({ id, name, sourceContentHash }) => ({ id, name, sourceContentHash }));
const mediaPrefix = '/media/uploads/';

function localName(asset: MediaAsset): string | null {
  const name = asset.src.startsWith(mediaPrefix) ? asset.src.slice(mediaPrefix.length) : '';
  return isSafeUploadName(name) ? name : null;
}

export function registeredAssets(entries: MediaAsset[]): MediaAsset[] | null {
  const assets = entries.slice(0, slots.length);
  return assets.length === slots.length && assets.every((asset, index) =>
    asset.kind === (index === 0 ? 'video' : 'image') && /^[a-f0-9]{64}$/.test(asset.sourceContentHash ?? '')
    && !!localName(asset)) && new Set(assets.map(asset => asset.src)).size === slots.length
    && assets[1].sourceContentHash !== assets[3].sourceContentHash ? assets : null;
}

export async function intactAsset(asset: MediaAsset, hashFile: typeof sha256File = sha256File): Promise<boolean> {
  const name = localName(asset);
  if (!name || !/^[a-f0-9]{64}$/.test(asset.sourceContentHash ?? '')) return false;
  const file = resolveUploadFile(name);
  try { return !!file && await hashFile(file) === asset.sourceContentHash; }
  catch { return false; }
}

async function inspect(file: string, slot: Slot, fps: number) {
  const image = slot !== 'source';
  const extension = extname(file);
  if (!image && extension === '.webm' && !await hasWebmDocType(file)) throw new Error('原片不是 WebM 封装');
  const formats = image ? imageFormats[extension]
    : extension === '.webm' ? 'matroska,webm' : 'mov,mp4,m4a,3gp,3g2,mj2';
  const { stdout } = await probe(ffprobeBin(), [
    '-v', 'error', '-protocol_whitelist', 'file',
    '-format_whitelist', formats,
    ...(image ? ['-show_entries', 'format=duration:stream=codec_type,width,height'] : ['-show_streams', '-show_format']),
    '-of', 'json', file,
  ], { timeout: 10_000, maxBuffer: 64 * 1024 });
  const data = JSON.parse(stdout);
  const video = data.streams?.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  if (!video?.width || !video.height) throw new Error('素材无法读取');
  const duration = Number(data.format?.duration);
  if (!image && (!Number.isFinite(duration) || duration <= 0
    || !data.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio'))) {
    throw new Error('原片须可播放且含音轨');
  }
  const dimensions = displayDimensions(video.width, video.height, image ? 0 : rotationOf(video));
  return { ...dimensions, durationInFrames: image ? 5 * fps : Math.max(1, Math.round(duration * fps)) };
}

/** Restore only the registered bytes at their original path. Analysis, board
 * and task receipts keep their asset and revision bindings. */
async function restoreRegisteredFiles(projectId: string, revision: string, assets: MediaAsset[], form: FormData,
  written: string[], hashFile: typeof sha256File) {
  const fields = [...form.keys()];
  if (!fields.length || new Set(fields).size !== fields.length || fields.some(field => !slots.includes(field as Slot)))
    throw new UploadFeedback('missing');
  const directory = uploadDir();
  await mkdir(directory, { recursive: true });
  const staged: { asset: MediaAsset; temporary: string }[] = [];
  for (const field of fields) {
    const asset = assets[slots.indexOf(field as Slot)];
    const file = form.get(field);
    if (!file || typeof file === 'string' || !file.size) throw new UploadFeedback('missing');
    const temporary = join(directory, `.clipmentor-restore-${randomUUID()}`);
    written.push(temporary);
    const { contentHash } = await streamUploadToFile(
      Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]), temporary, maxRequestBytes,
    );
    if (contentHash !== asset.sourceContentHash) throw new UploadFeedback('original');
    staged.push({ asset, temporary });
  }
  await withSerializedProjectStore(async store => {
    const stored = await store.readEntry(`project:${projectId}`);
    const doc = stored.found ? runProjectMigrations(stored.value)?.doc : null;
    if (!doc || revisionOf(doc) !== revision || uploadDir() !== directory) throw new UploadFeedback('changed');
    const stagedPositions = new Set(staged.map(entry => entry.asset));
    for (const asset of assets) {
      const name = localName(asset)!;
      if (resolveUploadFile(name)) {
        if (!await intactAsset(asset, hashFile)) throw new UploadFeedback('unavailable');
      } else if (!stagedPositions.has(asset)) throw new UploadFeedback('missing');
    }
    for (const { asset, temporary } of staged) {
      const name = localName(asset)!;
      if (!resolveUploadFile(name)) {
        // link publishes the full staged file atomically and cannot overwrite
        // an existing file, including one created by another process.
        await link(temporary, join(directory, name));
      }
    }
    if (!(await Promise.all(assets.map(asset => intactAsset(asset, hashFile)))).every(Boolean))
      throw new UploadFeedback('changed');
  });
  return { projectId, revision, assets: receiptAssets(assets) };
}

export function createMaterialIntakeHandler({ hashFile = sha256File }: { hashFile?: typeof sha256File } = {}) {
  const uploading = new Set<string>();
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, value: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(value));
    };
    const reading = req.method === 'GET';
    if ((!reading && req.method !== 'POST') || !editorCredentialAuthorized(req, !reading) || req.headers['sec-fetch-site'] !== 'same-origin') {
      send(403, { error: '仅允许本地 ClipMentor 页面上传' });
      return;
    }
    const projectId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('projectId') ?? '';
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(projectId)) {
      send(400, { error: '缺少有效工程' });
      return;
    }
    if (reading) {
      try {
        const saved = await loadOfflineStoredProject(projectId);
        if (!saved) { send(404, { error: '上传目标工程不存在' }); return; }
        const assets = registeredAssets(saved.doc.assets);
        const missingSlots: Slot[] = [];
        let complete = false;
        if (assets) {
          const intact = await Promise.all(assets.map(asset => intactAsset(asset, hashFile)));
          complete = intact.every(Boolean);
          // Offer a repair only for absent files. Existing different bytes
          // are left intact and need maintenance to verify their ownership.
          if (!complete && assets.every((asset, index) => intact[index] || !resolveUploadFile(localName(asset)!))) {
            missingSlots.push(...slots.filter((_slot, index) => !intact[index]));
          }
        }
        if ((await loadOfflineStoredProject(projectId))?.revision !== saved.revision) throw new Error('Material snapshot changed');
        const receipt = assets && { projectId, revision: saved.revision, assets: receiptAssets(assets) };
        send(200, { receipt: complete ? receipt : null, ...(receipt && missingSlots.length ? { repair: { ...receipt, missingSlots } } : {}) });
      } catch {
        send(503, { error: '暂时无法读取已上传素材' });
      }
      return;
    }
    const length = Number(req.headers['content-length']);
    const contentType = req.headers['content-type'];
    if (!Number.isSafeInteger(length) || length <= 0 || length > maxRequestBytes || !contentType?.startsWith('multipart/form-data;')) {
      send(413, { error:uploadFeedback.size,reason:'size' });
      return;
    }
    if (uploading.has(projectId) || uploading.size >= CLIPMENTOR_TASK_LIMIT) {
      const reason=uploading.has(projectId)?'saving':'busy';
      send(409, { error:uploadFeedback[reason],reason });
      return;
    }
    uploading.add(projectId);
    const written: string[] = [];
    let commitUncertain = false;
    let retained: string[] = [];
    let ownership: Awaited<ReturnType<typeof claimOfflineProjectOwnership>> | undefined;
    try {
      const initial = await loadOfflineStoredProject(projectId);
      if (!initial) throw new Error('上传目标工程不存在');
      const stream = Readable.toWeb(req);
      const request = new Request('http://localhost', {
        method: 'POST', headers: { 'content-type': contentType },
        body: stream as unknown as BodyInit, duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      const form = await request.formData();
      const started = !!initial.doc.clipMentorAnalysis || initial.doc.timelines.some(timeline => timeline.items.length);
      const registered = registeredAssets(initial.doc.assets);
      if (registered && (started || [...form.keys()].length < slots.length
        || registered.some(asset => !resolveUploadFile(localName(asset)!)))) {
        send(200, await restoreRegisteredFiles(projectId, initial.revision, registered, form, written, hashFile));
        return;
      }
      if (started) throw new UploadFeedback('alreadySaved');
      if ([...form.keys()].length !== slots.length) throw new UploadFeedback('missing');
      const timeline = initial.doc.timelines.find(t => t.id === initial.doc.activeTimelineId);
      if (!timeline) throw new Error('工程缺少活动时间线');
      const directory = uploadDir();
      await mkdir(directory, { recursive: true });
      const assets: MediaAsset[] = [];
      const staged = new Map<string, string>();
      for (const slot of slots) {
        const file = form.get(slot);
        if (!file || typeof file === 'string' || !file.size) throw new UploadFeedback('missing');
        if (!isSafeUploadName(file.name) || file.name.length > 180) throw new UploadFeedback('name');
        const kind = slot === 'source' ? 'video' : 'image';
        const extension = extname(file.name).toLowerCase();
        if (!allowed[kind].includes(extension)) throw new UploadFeedback('format');
        const id = randomUUID();
        const filename = `clipmentor-intake-${id}${extension}`;
        const local = join(directory, `.staged-${filename}`);
        written.push(local);
        const { bytes, contentHash } = await streamUploadToFile(
          Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]), local, maxRequestBytes,
        );
        const metadata = await inspect(local, slot, timeline.fps).catch(() => {
          throw new UploadFeedback(slot==='source'?'source':'image');
        });
        const src = mediaPrefix + filename;
        staged.set(src, local);
        assets.push({
          id, kind, name: file.name, sourceFilename: file.name, src,
          sourceContentHash: contentHash, sourceRevision: `source-sha256-${contentHash}`, sourceSize: bytes, ...metadata,
        });
      }
      if (assets[1]?.sourceContentHash === assets[3]?.sourceContentHash) {
        throw new UploadFeedback('sameImage');
      }
      const current = initial.doc.assets;
      let next = assets;
      let added = assets;
      if (current.length) {
        const same = (current.length === slots.length - 1 || current.length === slots.length) && current.every((asset, index) =>
          asset.name === assets[index]?.name && asset.kind === assets[index]?.kind
            && /^[a-f0-9]{64}$/.test(asset.sourceContentHash ?? '') && asset.sourceContentHash === assets[index]?.sourceContentHash);
        if (!same) throw new UploadFeedback('alreadySaved');
        const intact = await Promise.all(current.map(asset => intactAsset(asset, hashFile)));
        if (current.length === slots.length && intact.every(Boolean)) {
          // A byte-identical resubmission reads the saved receipt without editing.
          if ((await loadOfflineStoredProject(projectId))?.revision !== initial.revision) throw new UploadFeedback('changed');
          send(200, { projectId, revision: initial.revision, assets: receiptAssets(current) });
          return;
        }
        added = assets.filter((_asset, index) => index >= current.length || !intact[index]);
        next = assets.map((asset, index) => index >= current.length ? asset
          : intact[index] ? current[index] : { ...asset, id: current[index].id });
      }
      if (isProjectConnected(projectId)) throw new UploadFeedback('openEditor');
      ownership = await claimOfflineProjectOwnership(projectId, randomUUID());
      if (ownership.status !== 'claimed' || ownership.revision !== initial.revision) throw new UploadFeedback('changed');
      // Keep only files referenced by the commit. Retry/backfill staging copies
      // of already-saved assets stay eligible for cleanup.
      retained = added.map(asset => join(directory, asset.src.split('/').at(-1)!));
      const ownedDoc = ownership.doc;
      const result = await commitOfflineStoredProject({
        projectId, expectedRevision: ownership.revision, ownership: ownership.claim,
        // Only the first empty upload initializes the product canvas. An identical
        // retry/backfill never silently resizes a previously saved project.
        doc: { ...ownedDoc, assets: next, ...(!current.length?{timelines:ownedDoc.timelines.map(t=>
          t.id===ownedDoc.activeTimelineId?{...t,...CLIPMENTOR_OUTPUT_CANVAS}:t)}:{}) },
        canCommit: () => !isProjectConnected(projectId),
        publishMedia: async () => {
          if (uploadDir() !== directory) throw new Error('素材目录已变化，请重新核对');
          for (const [index, asset] of added.entries()) {
            const target = retained[index];
            await link(staged.get(asset.src)!, target);
            written.push(target);
          }
          // Once published, an uncertain project write keeps the original bytes.
          commitUncertain = true;
        },
      });
      if (result.status !== 'applied') {
        commitUncertain = false;
        throw new UploadFeedback('changed');
      }
      const saved = await loadOfflineStoredProject(projectId);
      if (saved?.revision !== result.revision || saved?.doc.assets.length !== next.length
        || next.some(asset => !saved?.doc.assets.some(entry => entry.id === asset.id && entry.src === asset.src && entry.sourceContentHash === asset.sourceContentHash))
        || !(await Promise.all(next.map(asset => intactAsset(asset, hashFile)))).every(Boolean)
        || (await loadOfflineStoredProject(projectId))?.revision !== result.revision) {
        throw new Error('已提交，回读未核实。请查看工程素材');
      }
      send(200, { projectId, revision: saved.revision, assets: receiptAssets(next) });
    } catch (error) {
      if(!(error instanceof UploadFeedback))console.error('ClipMentor material intake failed',projectId,error);
      const reason=error instanceof UploadFeedback?error.reason:'unavailable';
      send(409, { error:uploadFeedback[reason],reason,...(commitUncertain ? { commitUncertain: true } : {}) });
    } finally {
      await Promise.allSettled(written.filter(file => !commitUncertain || !retained.includes(file)).map(file => unlink(file)));
      if (ownership?.status === 'claimed') await releaseProjectEditOwnership(ownership.claim).catch(() => undefined);
      uploading.delete(projectId);
    }
  };
}
