import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { exportAttemptIdFromFilename, isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import { resolveCommittedExport } from './export-delivery.ts';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { formatTimeLabel, tileContactSheet } from '../frame-grid.ts';
import {
  assessExportQuality,
  parseExportQaLog,
  type ExportQaAnalysis,
  type ExportQaExpectations,
} from '../../src/export/quality.ts';

const MAX_JSON_BYTES = 64 * 1024;
const PROCESS_TIMEOUT_MS = 30 * 60_000;
const MAX_EVIDENCE_CUTS = 8;

interface ProcessResult {
  stdout: string;
  stderr: string;
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const match = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!match) return null;
  return isSafeUploadName(match[1]) ? match[1] : null;
}

function runProcess(command: string, args: string[], timeoutMs = PROCESS_TIMEOUT_MS): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exit ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

function parseRate(value?: string): number {
  if (!value) return 0;
  const [numerator, denominator = '1'] = value.split('/');
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) ? rate : 0;
}

async function probeMedia(file: string): Promise<Pick<
  ExportQaAnalysis,
  'durationSeconds' | 'width' | 'height' | 'fps' | 'hasVideo' | 'hasAudio'
>> {
  const { stdout } = await runProcess(ffprobeBin(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], 30_000);
  const probe = JSON.parse(stdout) as ProbeResult;
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = Number(probe.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    fps: parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}

async function analyzeVideo(file: string): Promise<string> {
  const { stderr } = await runProcess(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-i', file,
    '-map', '0:v:0', '-vf', 'blackdetect=d=0.12:pic_th=0.98:pix_th=0.10,freezedetect=n=-50dB:d=0.5',
    '-an', '-f', 'null', '-',
  ]);
  return stderr;
}

async function analyzeAudio(file: string): Promise<string> {
  const { stderr } = await runProcess(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-i', file,
    '-map', '0:a:0', '-af', 'silencedetect=n=-48dB:d=2,volumedetect',
    '-vn', '-f', 'null', '-',
  ]);
  return stderr;
}

async function extractFrame(file: string, seconds: number, output: string, measure: boolean): Promise<number | null> {
  const {stderr}=await runProcess(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', measure?'info':'error', '-y',
    ...(measure?['-copyts','-start_at_zero']:[]),
    '-ss', String(Math.max(0, seconds)), '-i', file,
    ...(measure?['-vf','showinfo']:[]),
    '-map','0:v:0','-frames:v', '1', '-q:v', '4', output,
  ]);
  if(!measure)return seconds;
  const pts=stderr.match(/\bn:\s*0\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.eE+-]+)/)?.[1];
  return pts!==undefined&&Number.isFinite(Number(pts))?Number(pts):null;
}

interface LabelProbe {
  id: string;
  cutSeconds: number;
  side: 'before' | 'after';
  region: [number, number, number, number];
  inkMinChannel: number;
}
type LabelMeasurement = LabelProbe &
  ({ status: 'measured'; sampleSeconds: number; backgroundRgb: number[]; inkHeightPx: number | null }
   | { status: 'unmeasured'; reason: 'cut_not_sampled' | 'frame_unavailable' | 'wrong_side' | 'timestamp_unavailable' });
function parseLabelProbes(value: unknown): LabelProbe[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_CUTS * 2) throw Error('Invalid export QA label probes');
  const ids = new Set<string>();
  return value.map(probe => {
    if (!probe || typeof probe.id !== 'string' || !probe.id.trim() || probe.id.length > 80 || ids.has(probe.id)
      || !Number.isFinite(probe.cutSeconds) || !['before','after'].includes(probe.side)
      || !Number.isInteger(probe.inkMinChannel) || probe.inkMinChannel < 1 || probe.inkMinChannel > 255
      || !Array.isArray(probe.region) || probe.region.length !== 4 || !probe.region.every(Number.isFinite))
      throw Error('Invalid export QA label probe');
    const [left,top,width,height] = probe.region;
    if (left < 0 || top < 0 || width <= 0 || height <= 0 || left + width > 1 || top + height > 1)
      throw Error('Invalid export QA label region');
    ids.add(probe.id);
    return {id:probe.id,cutSeconds:probe.cutSeconds,side:probe.side,region:[left,top,width,height],inkMinChannel:probe.inkMinChannel};
  });
}

/** The crop and ink threshold are supplied by the reviewer. No color or font verdict is inferred. */
async function measureLabel(jpeg: Buffer, probe: LabelProbe, sampleSeconds: number): Promise<LabelMeasurement> {
  const image = sharp(jpeg);
  const {width,height} = await image.metadata();
  const [left,top,w,h] = probe.region;
  const x = Math.floor(left * width), y = Math.floor(top * height);
  const rect = {left:x,top:y,width:Math.max(1,Math.floor((left + w) * width) - x),
    height:Math.max(1,Math.floor((top + h) * height) - y)};
  const {data,info} = await image.extract(rect).toColourspace('srgb').removeAlpha().raw().toBuffer({resolveWithObject:true});
  const channels = [new Uint32Array(256),new Uint32Array(256),new Uint32Array(256)];
  let first = info.height, last = -1;
  for (let offset=0;offset<data.length;offset+=3) {
    for (let index=0;index<3;index++) channels[index][data[offset+index]]++;
    if (Math.min(data[offset],data[offset+1],data[offset+2]) >= probe.inkMinChannel) {
      const row=Math.floor(offset/(3*info.width));
      first=Math.min(first,row);last=Math.max(last,row);
    }
  }
  const backgroundRgb=channels.map(bins=>{
    let seen=0;
    return bins.findIndex(count=>(seen+=count)>=info.width*info.height/2);
  });
  return {...probe,status:'measured',sampleSeconds,backgroundRgb,inkHeightPx:last<0?null:last-first+1};
}

async function buildCutEvidence(
  file: string,
  durationSeconds: number,
  fps: number,
  cutTimesSeconds: number[],
  maxCuts: number,
  probes: LabelProbe[],
): Promise<{ base64?: string; samples: { cutSeconds: number; sampleSeconds: number; side: 'before' | 'after' }[];
  labelMeasurements?: LabelMeasurement[]; labelMeasurementMs?: number }> {
  const cuts = [...new Set([...probes.map(probe=>probe.cutSeconds),...cutTimesSeconds.filter(Number.isFinite).sort((a,b)=>a-b)])]
    .filter(value=>value>0&&value<durationSeconds)
    .slice(0,Math.max(1,Math.min(MAX_EVIDENCE_CUTS,maxCuts))).sort((a,b)=>a-b);
  const missing=(probe:LabelProbe):LabelMeasurement=>({...probe,status:'unmeasured',
  reason:cuts.includes(probe.cutSeconds)?'frame_unavailable':'cut_not_sampled'});
  if (!cuts.length) return { samples: [],...(probes.length?{labelMeasurements:probes.map(missing),labelMeasurementMs:0}:{}) };

  const work = await mkdtemp(join(tmpdir(), 'occ-export-qa-'));
  try {
    const samples: { cutSeconds: number; sampleSeconds: number; side: 'before' | 'after' }[] = [];
    const cells: { jpeg: Buffer; label: string }[] = [];
    const measured=new Map<string,LabelMeasurement>();
    let labelMeasurementMs=0;
    const offset = Math.min(0.18, Math.max(0.04, 1 / 12));
    for (let cutIndex = 0; cutIndex < cuts.length; cutIndex += 1) {
      const cut = cuts[cutIndex]!;
      for (const side of ['before', 'after'] as const) {
        const frameProbes=probes.filter(probe=>probe.cutSeconds===cut&&probe.side===side);
        const framePeriod=frameProbes.length&&fps>0?1/fps:0;
        const seek=Math.max(0,Math.min(durationSeconds-0.001,cut+(side==='before'?-offset-framePeriod:offset)));
        const output = join(work, `cut-${cutIndex}-${side}.jpg`);
        try {
          const sampleSeconds=await extractFrame(file,seek,output,frameProbes.length>0);
          if(sampleSeconds===null||(frameProbes.length>0&&(side==='before'?sampleSeconds>=cut:sampleSeconds<cut))){
            for(const probe of frameProbes)measured.set(probe.id,{...probe,status:'unmeasured',
              reason:sampleSeconds===null?'timestamp_unavailable':'wrong_side'});
            continue;
          }
          const jpeg=await readFile(output);
          samples.push({ cutSeconds: cut, sampleSeconds, side });
          cells.push({jpeg,label:`cut ${cutIndex + 1} ${side} · ${formatTimeLabel(Math.round(sampleSeconds * 1000))}`});
          for(const probe of frameProbes){
            const start=performance.now();
            try{measured.set(probe.id,await measureLabel(jpeg,probe,sampleSeconds));}
            catch{/* Keep the frame evidence when a measurement cannot be read. */}
            finally{labelMeasurementMs+=performance.now()-start;}
          }
        } catch {
          // A damaged sample should not erase the rest of the QA report.
        }
      }
    }
    const labels=probes.length?{labelMeasurements:probes.map(probe=>measured.get(probe.id)??missing(probe)),labelMeasurementMs}:{};
    if (!cells.length) return { samples,...labels };
    const sheet = await tileContactSheet(cells, { cols: 2, cellWidth: 360 });
    return { base64: sheet.toString('base64'), samples,...labels };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export interface AnalyzeExportFileOptions extends ExportQaExpectations {
  cutTimesSeconds?: number[];
  maxEvidenceCuts?: number;
  labelProbes?: LabelProbe[];
}

/** Analyze one completed export and return both structured findings and cut evidence. */
export async function analyzeExportFile(file: string, options: AnalyzeExportFileOptions) {
  const probes=parseLabelProbes(options.labelProbes);
  const probe = await probeMedia(file);
  const [videoLog, audioLog] = await Promise.all([
    probe.hasVideo ? analyzeVideo(file) : Promise.resolve(''),
    probe.hasAudio ? analyzeAudio(file) : Promise.resolve(''),
  ]);
  const parsed = parseExportQaLog(`${videoLog}\n${audioLog}`);
  const report = assessExportQuality({ ...probe, ...parsed }, options);
  const evidence = probe.hasVideo
    ? await buildCutEvidence(
        file,
        probe.durationSeconds,
        probe.fps,
        options.cutTimesSeconds ?? [],
        options.maxEvidenceCuts ?? MAX_EVIDENCE_CUTS,
        probes,
      )
    : { samples: [],...(probes.length?{labelMeasurements:probes.map((entry):LabelMeasurement=>({...entry,status:'unmeasured',reason:'frame_unavailable'})),labelMeasurementMs:0}:{}) };
  return { report, evidence };
}

export function exportQaPlugin(): Plugin {
  return {
    name: 'openchatcut-export-qa',
    configureServer(server) {
      server.middlewares.use('/api/export-qa', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          const body = (await readJson(req)) as Partial<AnalyzeExportFileOptions> & { src?: string };
          const name = uploadNameFromSrc(String(body.src ?? ''));
          if (!name) {
            sendJson(res, 400, { error: 'src must be /media/uploads/<safe-name>' });
            return;
          }
          const file = exportAttemptIdFromFilename(name) ? (await resolveCommittedExport(name))?.file : resolveUploadFile(name);
          if (!file || !existsSync(file)) {
            sendJson(res, 404, { error: `export not found: ${name}` });
            return;
          }
          const expected: AnalyzeExportFileOptions = {
            durationSeconds: Math.max(0, Number(body.durationSeconds) || 0),
            width: Math.max(1, Math.round(Number(body.width) || 1)),
            height: Math.max(1, Math.round(Number(body.height) || 1)),
            fps: Math.max(1, Number(body.fps) || 30),
            expectsAudio: body.expectsAudio === true,
            cutTimesSeconds: Array.isArray(body.cutTimesSeconds)
              ? body.cutTimesSeconds.map(Number).filter(Number.isFinite)
              : [],
            maxEvidenceCuts: Math.max(1, Math.min(MAX_EVIDENCE_CUTS, Math.round(Number(body.maxEvidenceCuts) || MAX_EVIDENCE_CUTS))),
            labelProbes: body.labelProbes,
          };
          const { report, evidence } = await analyzeExportFile(file, expected);
          sendJson(res, 200, {
            ok: true,
            src: body.src,
            report,
            evidence: {
              mediaType: evidence.base64 ? 'image/jpeg' : undefined,
              base64: evidence.base64,
              samples: evidence.samples,
              ...('labelMeasurements' in evidence?{labelMeasurements:evidence.labelMeasurements,labelMeasurementMs:evidence.labelMeasurementMs}:{}),
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[export-qa] ${message}`);
          const status = message.startsWith('Invalid export QA label') ? 400 : /ENOENT|spawn|ffmpeg|ffprobe/i.test(message) ? 503 : 500;
          sendJson(res, status, { error: message });
        }
      });
    },
  };
}
