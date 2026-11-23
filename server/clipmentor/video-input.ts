import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';

/** Conservative, previously exercised Rootify URL admission; not the R2 storage limit. */
export const VIDEO_URL_MAX_BYTES = 15_000_000;
export const VIDEO_REQUEST_MAX_BYTES = 100_000_000;
const formats = {
  '.mp4': { extension: '.mp4', mimeType: 'video/mp4' },
  '.mov': { extension: '.mov', mimeType: 'video/quicktime' },
  '.webm': { extension: '.webm', mimeType: 'video/webm' },
} as const;
type VideoFormat = (typeof formats)[keyof typeof formats];
export type VideoMimeType = VideoFormat['mimeType'];

export function videoFileFormat(file: string): VideoFormat | undefined {
  return formats[extname(file).toLowerCase() as keyof typeof formats];
}

function vintWidth(byte: number, maxWidth: number): number {
  for (let width = 1; width <= maxWidth; width++) if (byte & (0x80 >> (width - 1))) return width;
  return 0;
}

function ebmlPayload(bytes: Buffer, offset: number, limit: number): [number, number] | undefined {
  const width = vintWidth(bytes[offset], 8);
  if (!width || offset + width > limit) return;
  let size = bytes[offset] & (0xff >> width);
  for (let i = 1; i < width; i++) size = size * 256 + bytes[offset + i];
  const start = offset + width;
  if (size === 2 ** (7 * width) - 1 || size > limit - start) return;
  return [start, start + size];
}

/** FFprobe reports the same demuxer for Matroska and WebM. Use the actual EBML DocType. */
export async function hasWebmDocType(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  const buffer = Buffer.alloc(4096);
  let bytes: Buffer;
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    bytes = buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
  if (bytes.length < 5 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const header = ebmlPayload(bytes, 4, bytes.length);
  if (!header) return false;
  let docType: string | undefined;
  for (let offset = header[0]; offset < header[1];) {
    const width = vintWidth(bytes[offset], 4);
    if (!width || offset + width >= header[1]) return false;
    const payload = ebmlPayload(bytes, offset + width, header[1]);
    if (!payload) return false;
    if (width === 2 && bytes.readUInt16BE(offset) === 0x4282) {
      if (docType !== undefined) return false;
      docType = bytes.subarray(...payload).toString('latin1').replace(/\0+$/u, '');
    }
    offset = payload[1];
  }
  return docType === 'webm';
}

export interface MediaTransferReceipt {
  version: 'original-video-transfer-v1';
  mode: 'inline' | 'r2';
  sha256: string;
  bytes: number;
  scope: 'full_original_bytes';
  verified_to: 'request_bytes' | 'object_store';
  reused: boolean;
  storage_requests: number;
  attempted_part_bytes: number;
  confirmed_part_bytes: number;
  downloaded_bytes: number;
  elapsed_ms: number;
  model_fetch_verified: false;
  cost: 'unknown';
}
export interface PreparedVideo {
  readonly sha256: string;
  readonly bytes: number;
  readonly part: { inlineData: { mimeType: string; data: string }; videoMetadata: { fps: number } }
    | { fileData: { mimeType: string; fileUri: string }; videoMetadata: { fps: number } };
  readonly receipt: MediaTransferReceipt;
}
const prepared = new WeakSet<object>();
export type VideoInput = Uint8Array | PreparedVideo;

/** Only a verified adapter can introduce a URL; candidates/agents cannot provide arbitrary links. */
export function sealVideo(value: PreparedVideo): PreparedVideo {
  Object.freeze(value.receipt);
  if ('fileData' in value.part) Object.freeze(value.part.fileData);
  else Object.freeze(value.part.inlineData);
  Object.freeze(value.part.videoMetadata); Object.freeze(value.part); Object.freeze(value);
  prepared.add(value);
  return value;
}
export function videoInput(value: VideoInput, mimeType: VideoMimeType = 'video/mp4'): PreparedVideo {
  if (value instanceof Uint8Array) {
    const bytes = value.byteLength;
    if (!bytes || 4 * Math.ceil(bytes / 3) > VIDEO_REQUEST_MAX_BYTES) throw Error('Video exceeds bounded inline request size');
    const sha256 = createHash('sha256').update(value).digest('hex');
    return sealVideo({ sha256, bytes,
      part: { inlineData: { mimeType, data: Buffer.from(value).toString('base64') }, videoMetadata: { fps: 5 } },
      receipt: { version:'original-video-transfer-v1', mode:'inline', sha256, bytes, scope:'full_original_bytes', verified_to:'request_bytes',
        reused:false,storage_requests:0,attempted_part_bytes:0,confirmed_part_bytes:0,downloaded_bytes:0,elapsed_ms:0,model_fetch_verified:false,cost:'unknown' } });
  }
  if (!value || !prepared.has(value)) throw Error('Unverified video reference');
  return value;
}

/** Stable across URL renewal; the actual wire request retains its own separate hash. */
export function videoRequestDigest(body: unknown, media: Pick<PreparedVideo,'sha256'|'bytes'>, mimeType: VideoMimeType = 'video/mp4'): string {
  const source=body as {contents:Array<{parts:unknown[]}>};
  const canonical={...source,contents:source.contents.map((content,i)=>i===0?{...content,parts:[
    {original_video_sha256:media.sha256,bytes:media.bytes,fps:5,
      ...(mimeType === 'video/mp4' ? {} : { mime_type: mimeType })},...content.parts.slice(1)]}:content)};
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
export function echoesMediaSecret(value: unknown, media: PreparedVideo): boolean {
  if(!('fileData' in media.part))return false;
  const uri=media.part.fileData.fileUri, encoded=JSON.stringify(value)??'';
  const signature=new URL(uri).searchParams.get('X-Amz-Signature');
  return encoded.includes(uri) || (!!signature && encoded.includes(signature));
}
