import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { MediaAsset } from '../../src/editor/types';
import { editorCredentialAuthorized } from '../editor-auth';
import { isProjectConnected } from '../external-agent/broker';
import { commitOfflineStoredProject, loadOfflineStoredProject } from '../external-agent/offline-project-store';
import { claimOfflineProjectOwnership, releaseProjectEditOwnership } from '../external-agent/project-edit-ownership';
import { ffprobeBin } from '../media-binaries';
import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir';
import { streamUploadToFile } from '../plugins/upload-stream';
import { sha256File } from '../../shared/node-content-hash';

const maxRequestBytes = 64 * 1024 * 1024;
const slots = ['source', 'product', 'sales', 'cta'] as const;
const allowed = { video: ['.mp4', '.mov', '.webm'], image: ['.png', '.jpg', '.jpeg', '.webp'] };
const imageFormats: Record<string, string> = { '.png': 'png_pipe', '.jpg': 'jpeg_pipe', '.jpeg': 'jpeg_pipe', '.webp': 'webp_pipe' };
const probe = promisify(execFile);
type Slot = typeof slots[number];
const receiptAssets = (entries: MediaAsset[]) => entries.map(({ id, name, sourceContentHash }) => ({ id, name, sourceContentHash }));

async function inspect(file: string, slot: Slot, fps: number) {
  const image = slot !== 'source';
  const formats = image ? imageFormats[extname(file)]
    : extname(file) === '.webm' ? 'matroska,webm' : 'mov,mp4,m4a,3gp,3g2,mj2';
  const { stdout } = await probe(ffprobeBin(), [
    '-v', 'error', '-protocol_whitelist', 'file',
    '-format_whitelist', formats,
    '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file,
  ], { timeout: 10_000, maxBuffer: 64 * 1024 });
  const data = JSON.parse(stdout);
  const video = data.streams?.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  if (!video?.width || !video.height) throw new Error('素材无法读取');
  const duration = Number(data.format?.duration);
  if (!image && (!Number.isFinite(duration) || duration <= 0
    || !data.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio'))) {
    throw new Error('原片须可播放且含音轨');
  }
  return { width: video.width, height: video.height, durationInFrames: image ? 5 * fps : Math.max(1, Math.round(duration * fps)) };
}

export function createMaterialIntakeHandler() {
  let uploading = false;
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
        const assets = saved.doc.assets.slice(0, slots.length);
        const complete = assets.length === slots.length && assets.every((asset, index) =>
          asset.kind === (index === 0 ? 'video' : 'image') && !!asset.sourceContentHash
          && asset.src.startsWith('/media/uploads/') && !!resolveUploadFile(asset.src.slice('/media/uploads/'.length)),
        ) && assets[1]?.sourceContentHash !== assets[3]?.sourceContentHash;
        send(200, { receipt: complete ? { projectId, revision: saved.revision, assets: receiptAssets(assets) } : null });
      } catch {
        send(503, { error: '暂时无法读取已上传素材' });
      }
      return;
    }
    const length = Number(req.headers['content-length']);
    const contentType = req.headers['content-type'];
    if (!Number.isSafeInteger(length) || length <= 0 || length > maxRequestBytes || !contentType?.startsWith('multipart/form-data;')) {
      send(413, { error: '请提交四份素材，合计不得超过 64 MiB' });
      return;
    }
    if (uploading) {
      send(409, { error: '已有上传正在保存' });
      return;
    }
    uploading = true;
    const written: string[] = [];
    let commitUncertain = false;
    let retained: string[] = [];
    let ownership: Awaited<ReturnType<typeof claimOfflineProjectOwnership>> | undefined;
    try {
      const initial = await loadOfflineStoredProject(projectId);
      if (!initial || initial.doc.clipMentorAnalysis || initial.doc.timelines.some(timeline => timeline.items.length)) {
        throw new Error('上传目标必须是尚未制作的工程');
      }
      const stream = Readable.toWeb(req);
      const request = new Request('http://localhost', {
        method: 'POST', headers: { 'content-type': contentType },
        body: stream as unknown as BodyInit, duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      const form = await request.formData();
      if ([...form.keys()].length !== slots.length) throw new Error('需要原片、商品图、销量截图和 CTA 行动号召图各一份');
      const timeline = initial.doc.timelines.find(t => t.id === initial.doc.activeTimelineId);
      if (!timeline) throw new Error('工程缺少活动时间线');
      const directory = uploadDir();
      await mkdir(directory, { recursive: true });
      const assets: MediaAsset[] = [];
      for (const slot of slots) {
        const file = form.get(slot);
        if (!file || typeof file === 'string' || !file.size || !isSafeUploadName(file.name) || file.name.length > 180) {
          throw new Error('缺少素材或文件名无效');
        }
        const kind = slot === 'source' ? 'video' : 'image';
        const extension = extname(file.name).toLowerCase();
        if (!allowed[kind].includes(extension)) throw new Error('素材格式与上传位置不符');
        const id = randomUUID();
        const filename = `clipmentor-intake-${id}${extension}`;
        const local = join(directory, filename);
        written.push(local);
        const { bytes, contentHash } = await streamUploadToFile(
          Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]), local, maxRequestBytes,
        );
        const metadata = await inspect(local, slot, timeline.fps).catch(() => {
          throw new Error(slot === 'source' ? '原片无法读取、格式不符或缺少音轨' : `${file.name} 无法读取或实际图片格式与扩展名不符`);
        });
        assets.push({
          id, kind, name: file.name, sourceFilename: file.name, src: `/media/uploads/${filename}`,
          sourceContentHash: contentHash, sourceRevision: `source-sha256-${contentHash}`, sourceSize: bytes, ...metadata,
        });
      }
      if (assets[1]?.sourceContentHash === assets[3]?.sourceContentHash) {
        throw new Error('商品图和 CTA 行动号召图不能使用同一文件');
      }
      const current = initial.doc.assets;
      let next = assets;
      let added = assets;
      if (current.length) {
        const same = (current.length === slots.length - 1 || current.length === slots.length) && (await Promise.all(current.map(async (asset, index) => {
          const path = resolveUploadFile(asset.src.replace(/^\/media\/uploads\//, ''));
          return !!path && asset.name === assets[index]?.name && asset.kind === assets[index]?.kind
            && asset.sourceContentHash === assets[index]?.sourceContentHash && await sha256File(path) === asset.sourceContentHash;
        }))).every(Boolean);
        if (!same) throw new Error('工程已有不同素材，请核对工程，现有素材未覆盖');
        if (current.length === slots.length) {
          // A byte-identical resubmission reads the saved receipt without editing.
          if ((await loadOfflineStoredProject(projectId))?.revision !== initial.revision) throw new Error('工程已变化，请重新核对');
          send(200, { projectId, revision: initial.revision, assets: receiptAssets(current) });
          return;
        }
        added = assets.slice(current.length);
        next = [...current, ...added];
      }
      if (isProjectConnected(projectId)) throw new Error('请先关闭该工程的编辑器再上传');
      ownership = await claimOfflineProjectOwnership(projectId, randomUUID());
      if (ownership.status !== 'claimed' || ownership.revision !== initial.revision) throw new Error('工程正在使用或已变化，请重新核对');
      // Keep only files referenced by the commit. Retry/backfill staging copies
      // of already-saved assets stay eligible for cleanup.
      retained = added.map(asset => join(directory, asset.src.split('/').at(-1)!));
      commitUncertain = true;
      const result = await commitOfflineStoredProject({
        projectId, expectedRevision: ownership.revision, ownership: ownership.claim,
        doc: { ...ownership.doc, assets: next }, canCommit: () => !isProjectConnected(projectId),
      });
      if (result.status !== 'applied') {
        commitUncertain = false;
        throw new Error('素材未登记，工程可能刚被打开');
      }
      const saved = await loadOfflineStoredProject(projectId);
      if (saved?.revision !== result.revision || saved?.doc.assets.length !== next.length
        || next.some(asset => !saved?.doc.assets.some(entry => entry.id === asset.id && entry.sourceContentHash === asset.sourceContentHash))) {
        throw new Error('已提交，回读未核实。请查看工程素材');
      }
      send(200, { projectId, revision: saved.revision, assets: receiptAssets(next) });
    } catch (error) {
      const message = error instanceof Error && /[\u3400-\u9fff]/u.test(error.message)
        ? error.message : '上传或媒体检查失败，请检查文件是否完整';
      send(409, { error: message });
    } finally {
      await Promise.allSettled(written.filter(file => !commitUncertain || !retained.includes(file)).map(file => unlink(file)));
      if (ownership?.status === 'claimed') await releaseProjectEditOwnership(ownership.claim).catch(() => undefined);
      uploading = false;
    }
  };
}
