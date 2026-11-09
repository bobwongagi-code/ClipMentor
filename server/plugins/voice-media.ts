import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { uploadDir } from '../media-dir.ts';
import { fetchGeneratedResult } from './result-download.ts';
import {sha256File} from '../../shared/node-content-hash.ts';

function rawFormat(codec: string): string | undefined {
  if (codec === 'pcm') return 's16le';
  if (codec === 'ulaw' || codec === 'pcmu_raw') return 'mulaw';
  if (codec === 'alaw') return 'alaw';
  return undefined;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffmpeg', args);
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('voice audio processing timed out'));},120_000);
    let error = '';
    child.stderr.on('data', (data) => { error += String(data); });
    child.on('error', error=>{clearTimeout(timer);reject(error);});
    child.on('close', (code) => {clearTimeout(timer);code === 0 ? resolvePromise() : reject(new Error(error.slice(-500)));});
  });
}

async function wrapRaw(bytes: Buffer, codec: string, sampleRate: number): Promise<string> {
  const dir = uploadDir();
  const stem = randomUUID();
  const input = join(dir, `${stem}.raw`);
  const output = join(dir, `${stem}.wav`);
  await writeFile(input, bytes);
  try {
    await runFfmpeg(['-y', '-f', rawFormat(codec)!, '-ar', String(sampleRate), '-ac', '1', '-i', input, output]);
  } finally {
    await unlink(input).catch(() => undefined);
  }
  return output;
}

async function pitchShift(file: string, semitones: number, sampleRate: number): Promise<void> {
  if (!semitones) return;
  const factor = 2 ** (semitones / 12);
  const output = `${file}.pitched.mp3`;
  await runFfmpeg(['-y', '-i', file, '-af', `asetrate=${sampleRate}*${factor},aresample=${sampleRate},atempo=${1 / factor}`, output]);
  await unlink(file);
  await rename(output, file);
}

function probeDuration(file: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('voice duration measurement timed out'));},30_000);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.on('error', error=>{clearTimeout(timer);reject(error);});
    child.on('close', (code) => {
      clearTimeout(timer);const duration = Number(output.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolvePromise(duration);
      else reject(new Error('unable to probe generated audio'));
    });
  });
}

function extension(codec: string): string {
  if (codec === 'pcmu_wav' || codec === 'wav') return 'wav';
  if (codec === 'flac') return 'flac';
  if (codec === 'opus') return 'opus';
  if (codec === 'aac') return 'aac';
  return 'mp3';
}

export async function saveVoiceAudio(bytes: Buffer, codec: string, sampleRate: number, pitch = 0): Promise<{ path: string; durationSeconds: number; sha256:string }> {
  if (!bytes.length) throw new Error('voice provider returned empty audio');
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  let file: string;
  if (rawFormat(codec)) file = await wrapRaw(bytes, codec, sampleRate);
  else {
    const expected=createHash('sha256').update(bytes).digest('hex');
    file = join(dir, `${pitch?randomUUID():`voice-${expected}`}.${extension(codec)}`);
    try{await writeFile(file,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    if(await sha256File(file)!==expected)throw Error('saved voice bytes changed; repair locally, do not regenerate');
  }
  await pitchShift(file, pitch, sampleRate);
  return { path: `/media/uploads/${file.split('/').pop()!}`, durationSeconds: await probeDuration(file),sha256:await sha256File(file) };
}

export async function saveVoiceSubtitle(url: string): Promise<string> {
  const response = await fetchGeneratedResult(url, 'subtitle');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 5_000_000) throw new Error('MiniMax subtitle file is empty or too large');
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.minimax-subtitles.json`;
  const file = join(dir, filename);
  const partial = `${file}.part`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, file);
    return `/media/uploads/${filename}`;
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}
