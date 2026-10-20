import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { getKey } from '../keystore.ts';
import { resolveUploadFile, isSafeUploadName } from '../media-dir.ts';
import { runtimeProfile } from '../runtime-profile.ts';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { spawnMediaProcess, ffmpegThreadArgs } from '../media-process.ts';
import { atomicWriteFile } from './project-store-durable.ts';
import { sha256File } from '../../shared/node-content-hash.ts';
import { ASR_AUDIO, ASR_MAX_BYTES, FUNASR_MODEL, planAsrChunks, stitchAsrChunks } from '../../shared/clipmentor-asr.ts';
import type { SourceTranscription, SourceWord } from '../../shared/clipmentor-asr.ts';

interface SourceRequest {
  src: string; expectedSourceHash?: string; sourceSize?: number;
  language: string; operationId: string; maxRequests: number;
}
interface Dependencies {
  key(): string;
  endpoint(): string;
  resolve(name: string): string | null;
  hash(file: string): Promise<string>;
  probe(file: string): Promise<{ duration: number; fps: number; bytes: number }>;
  encode(file: string, start: number, end: number, output: string): Promise<Uint8Array>;
  fetch: typeof fetch;
  directory: string;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function parseRequest(v: unknown): SourceRequest {
  if (!object(v) || typeof v.src !== 'string' || !/^\/media\/uploads\/[^/?#]+$/.test(v.src)
    || typeof v.operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.operationId)
    || typeof v.language !== 'string' || !/^(auto|[a-z]{2,3})$/.test(v.language)
    || !Number.isSafeInteger(v.maxRequests) || Number(v.maxRequests) < 1 || Number(v.maxRequests) > 100
    || (v.expectedSourceHash !== undefined && !sha(v.expectedSourceHash))
    || (v.sourceSize !== undefined && (!Number.isSafeInteger(v.sourceSize) || Number(v.sourceSize) <= 0))) throw new Error('Invalid source transcription request');
  const name = decodeURIComponent(v.src.slice('/media/uploads/'.length));
  if (!isSafeUploadName(name) || /\.(normalized|proxy|asr)\./i.test(name)) throw new Error('Original uploaded master required; derivatives are not source identity');
  return v as unknown as SourceRequest;
}

/** Provider words stay untouched except for ms→seconds and the declared chunk offset. */
export function parseFunAsrResponse(value: unknown, offset: number): { words: SourceWord[]; language: string | null; requestId?: string; separators: number } {
  if (!object(value) || value.code || !object(value.output)) throw new Error('Invalid Fun-ASR response');
  const output = object(value.output.output) ? value.output.output : value.output;
  const sentences = Array.isArray(output.sentence) ? output.sentence : object(output.sentence) ? [output.sentence] : [];
  const words: SourceWord[] = [];
  let separators = 0;
  for (const sentence of sentences) {
    if (!object(sentence) || !Array.isArray(sentence.words)) throw new Error('Fun-ASR word timestamps missing');
    for (const word of sentence.words) {
      if (!object(word) || typeof word.text !== 'string') throw new Error('Invalid Fun-ASR word entry');
      if (!word.text.trim()) { separators++; continue; }
      if (typeof word.begin_time !== 'number' || !Number.isFinite(word.begin_time) || word.begin_time < 0
        || typeof word.end_time !== 'number' || !Number.isFinite(word.end_time) || word.end_time < word.begin_time) throw new Error('Invalid Fun-ASR word timestamps');
      words.push({ text: word.text.trim(), start_seconds: offset + word.begin_time / 1000, end_seconds: offset + word.end_time / 1000 });
    }
  }
  if (!words.length) throw new Error('Fun-ASR word timestamps missing');
  const requestId = value.request_id ?? output.request_id;
  return { words, separators, language: typeof output.language === 'string' ? output.language : null,
    ...(typeof requestId === 'string' ? { requestId } : {}) };
}

/** One reserved operation, no automatic retries. Ambiguous prior attempts never replay. */
export async function transcribeClipMentorSource(input: unknown, deps: Dependencies, signal?: AbortSignal): Promise<SourceTranscription> {
  const request = parseRequest(input);
  const key = deps.key(), endpoint = deps.endpoint();
  if (!key) throw new Error('ClipMentor Fun-ASR server credential is not configured');
  if (!/^https:\/\/[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/.test(endpoint)) throw new Error('ClipMentor Fun-ASR Singapore endpoint is not configured');
  const file = deps.resolve(decodeURIComponent(request.src.slice('/media/uploads/'.length)));
  if (!file) throw new Error('Original uploaded master is unavailable');
  const sourceHash = await deps.hash(file);
  const metadata = await deps.probe(file);
  if (request.expectedSourceHash ? request.expectedSourceHash !== sourceHash
    : request.sourceSize === undefined || request.sourceSize !== metadata.bytes) throw new Error('Source identity mismatch; original master hash or matching original byte size required');
  if (!Number.isFinite(metadata.duration) || metadata.duration <= 0 || !Number.isFinite(metadata.fps) || metadata.fps <= 0) throw new Error('Valid source duration and frame rate required');
  const identity = { ...request, expectedSourceHash: sourceHash };
  const fingerprint = digest(new TextEncoder().encode(JSON.stringify(identity)));
  await mkdir(deps.directory, { recursive: true, mode: 0o700 });
  const ledger = join(deps.directory, `${request.operationId}.json`);
  try {
    await writeFile(ledger, JSON.stringify({ fingerprint, status: 'reserved', requests_attempted: 0 }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Could not reserve transcription operation');
    const prior = JSON.parse(await readFile(ledger, 'utf8')) as { fingerprint: string; result?: SourceTranscription };
    if (prior.fingerprint !== fingerprint) throw new Error('Operation ID already belongs to another source or configuration');
    if (prior.result) return prior.result;
    throw new Error('Prior operation is running or outcome unknown; no automatic replay');
  }
  const result: SourceTranscription = {
    schema_version: 1, operation_id: request.operationId, provider: 'fun-asr', model: FUNASR_MODEL,
    requested_language: request.language, detected_language: null, source_hash: sourceHash,
    duration_seconds: metadata.duration, fps: metadata.fps, audio: ASR_AUDIO,
    status: 'failed', requests_attempted: 0, chunks: [], words: [], conflicts: [], issues: [],
  };
  const save = () => atomicWriteFile(ledger, JSON.stringify({ fingerprint, result }));
  const temporary = await mkdtemp(join(deps.directory, 'audio-'));
  try {
    const ranges = planAsrChunks(metadata.duration);
    if (ranges.length > request.maxRequests) throw new Error('Planned chunks exceed request budget');
    // Finish extraction/size subdivision before any chargeable request.
    const encoded: Uint8Array[] = [];
    for (let i = 0; i < ranges.length; i++) {
      signal?.throwIfAborted();
      const [start, end] = ranges[i];
      const bytes = await deps.encode(file, start, end, join(temporary, `${i}.mp3`));
      if (bytes.length > ASR_MAX_BYTES) {
        if (end - start <= 4) throw new Error('Encoded audio exceeds byte limit at minimum chunk length');
        const middle = (start + end) / 2;
        ranges.splice(i, 1, [start, middle + 1], [middle - 1, end]);
        if (ranges.length > request.maxRequests) throw new Error('Size subdivision exceeds request budget');
        i--; continue;
      }
      if (!bytes.length) throw new Error('Audio extraction returned no bytes');
      encoded.push(bytes);
      result.chunks.push({ chunk_id: `chunk-${i + 1}`, offset_seconds: start, end_seconds: end,
        audio_bytes: bytes.length, audio_sha256: digest(bytes), status: 'not_requested', words: [], detected_language: null });
    }
    if (encoded.length > request.maxRequests) throw new Error('Planned chunks exceed the explicitly supplied request budget; no provider request sent');
    if (await deps.hash(file) !== sourceHash) throw new Error('Source changed during extraction');
    for (let i = 0; i < result.chunks.length; i++) {
      signal?.throwIfAborted();
      const chunk = result.chunks[i];
      result.requests_attempted++;
      // Reserve before network I/O: timeouts and crashes count as attempts too.
      await atomicWriteFile(ledger, JSON.stringify({ fingerprint, status: 'request_reserved', requests_attempted: result.requests_attempted }));
      let stage: 'network' | 'http' | 'json' | 'timestamps' = 'network';
      try {
        const response = await deps.fetch(endpoint, {
          method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' },
          body: JSON.stringify({ model: FUNASR_MODEL, input: { messages: [{ role: 'user', content: [{ type: 'input_audio',
            input_audio: { data: `data:audio/mp3;base64,${Buffer.from(encoded[i]).toString('base64')}` } }] }] },
          parameters: { format: 'mp3', sample_rate: '16000', ...(request.language === 'auto' ? {} : { language_hints: [request.language] }) }, resources: [] }),
        });
        chunk.http_status = response.status; stage = 'http';
        if (!response.ok) throw new Error('Provider HTTP failure');
        stage = 'json'; const body: unknown = await response.json();
        stage = 'timestamps'; const parsed = parseFunAsrResponse(body, chunk.offset_seconds);
        chunk.words = parsed.words; chunk.detected_language = parsed.language; chunk.request_id = parsed.requestId;
        chunk.separator_entries_skipped = parsed.separators;
        chunk.status = 'completed';
      } catch {
        // Never expose upstream bodies, request headers, audio or credential-bearing exceptions.
        chunk.status = 'failed'; chunk.error = 'provider_request_failed_or_invalid_timestamps';
        chunk.failure_stage = stage;
        result.issues.push(`${chunk.chunk_id}:provider_request_failed_or_invalid_timestamps`);
        break;
      }
    }
    Object.assign(result, stitchAsrChunks(result.chunks));
    if (await deps.hash(file) !== sourceHash) result.issues.push('source_changed_during_transcription');
    if (result.conflicts.length) result.issues.push('overlap_conflict');
    for (const chunk of result.chunks) {
      if (chunk.words.some((w) => w.end_seconds > chunk.end_seconds || w.start_seconds < chunk.offset_seconds)) result.issues.push(`${chunk.chunk_id}:word_outside_chunk`);
    }
    if (result.words.some((w) => w.end_seconds > metadata.duration)) result.issues.push('source_time_out_of_bounds');
    const languages = new Set(result.chunks.flatMap((c) => c.detected_language ? [c.detected_language] : []));
    if (languages.size === 1) result.detected_language = [...languages][0];
    else if (languages.size > 1) result.issues.push('detected_language_disagreement');
    const completed = result.chunks.filter((c) => c.status === 'completed').length;
    result.status = completed === result.chunks.length ? 'completed' : completed ? 'partial' : 'failed';
  } catch {
    result.issues.push('extraction_budget_or_operation_failed');
    result.status = result.chunks.some((c) => c.status === 'completed') ? 'partial' : 'failed';
  } finally {
    await save();
    await rm(temporary, { recursive: true, force: true });
  }
  return result;
}

function processOutput(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnMediaProcess(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Media processing timed out')); }, 120_000);
    child.stdout?.on('data', (data: Buffer) => { if (output.length < 1_000_000) output += String(data); });
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Media processing unavailable')); });
    child.once('close', (code) => { clearTimeout(timeout); if (code === 0) resolve(output); else reject(new Error('Media processing failed')); });
  });
}
export function clipMentorAsrDependencies(): Dependencies {
  return {
    key: () => getKey('CLIPMENTOR_FUNASR_API_KEY'), endpoint: () => getKey('CLIPMENTOR_FUNASR_ENDPOINT'),
    resolve: resolveUploadFile, hash: sha256File, fetch: (...args) => fetch(...args),
    directory: join(runtimeProfile().rootDir, 'clipmentor-asr'),
    async probe(file) {
      const { stat } = await import('node:fs/promises');
      const data = JSON.parse(await processOutput(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration,avg_frame_rate', '-of', 'json', file]));
      if (!data.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio')) throw new Error('Source has no audio');
      const video = data.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
      const rate = String(video?.avg_frame_rate ?? '0/1').split('/').map(Number);
      return { duration: Number(video?.duration ?? data.format.duration), fps: rate[0] / rate[1], bytes: (await stat(file)).size };
    },
    async encode(file, start, end, output) {
      await processOutput(ffmpegBin(), [...ffmpegThreadArgs(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(start), '-i', file, '-t', String(end - start), '-vn', '-map', '0:a:0',
        '-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', '-ar', '16000', output]);
      return readFile(output);
    },
  };
}
export function clipMentorFunAsrPlugin(deps?: Dependencies): Plugin {
  return { name: 'clipmentor-funasr', configureServer(server) {
    server.middlewares.use('/api/clipmentor/transcribe-source', async (req: IncomingMessage, res: ServerResponse) => {
      const send = (status: number, body: unknown) => { if (!res.destroyed) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); } };
      if (req.method !== 'POST') { req.resume(); send(405, { error: 'POST required' }); return; }
      if (!editorCredentialAuthorized(req, true)) { req.resume(); send(401, { error: 'Editor origin required' }); return; }
      if (!String(req.headers['content-type']).startsWith('application/json')) { req.resume(); send(415, { error: 'JSON required' }); return; }
      const abort = new AbortController();
      const onClose = () => { if (!res.writableEnded) abort.abort(); };
      res.on('close', onClose);
      try {
        const parts: Buffer[] = []; let size = 0;
        for await (const part of req) { size += part.length; if (size > 8192) throw new Error('Body too large'); parts.push(Buffer.from(part)); }
        const result = await transcribeClipMentorSource(JSON.parse(Buffer.concat(parts).toString('utf8')), deps ?? clipMentorAsrDependencies(), abort.signal);
        send(200, result);
      } catch {
        send(400, { error: 'Source transcription unavailable or invalid input; check server configuration, original source and operation record. No automatic retry.' });
      } finally { res.off('close', onClose); }
    });
  } };
}
