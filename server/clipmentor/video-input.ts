import { createHash } from 'node:crypto';

/** Conservative, previously exercised Rootify URL admission; not the R2 storage limit. */
export const VIDEO_URL_MAX_BYTES = 15_000_000;
export const VIDEO_REQUEST_MAX_BYTES = 100_000_000;
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
export function videoInput(value: VideoInput): PreparedVideo {
  if (value instanceof Uint8Array) {
    const bytes = value.byteLength;
    if (!bytes || 4 * Math.ceil(bytes / 3) > VIDEO_REQUEST_MAX_BYTES) throw Error('Video exceeds bounded inline request size');
    const sha256 = createHash('sha256').update(value).digest('hex');
    return sealVideo({ sha256, bytes,
      part: { inlineData: { mimeType: 'video/mp4', data: Buffer.from(value).toString('base64') }, videoMetadata: { fps: 5 } },
      receipt: { version:'original-video-transfer-v1', mode:'inline', sha256, bytes, scope:'full_original_bytes', verified_to:'request_bytes',
        reused:false,storage_requests:0,attempted_part_bytes:0,confirmed_part_bytes:0,downloaded_bytes:0,elapsed_ms:0,model_fetch_verified:false,cost:'unknown' } });
  }
  if (!value || !prepared.has(value)) throw Error('Unverified video reference');
  return value;
}

/** Stable across URL renewal; the actual wire request retains its own separate hash. */
export function videoRequestDigest(body: unknown, media: Pick<PreparedVideo,'sha256'|'bytes'>): string {
  const source=body as {contents:Array<{parts:unknown[]}>};
  const canonical={...source,contents:source.contents.map((content,i)=>i===0?{...content,parts:[
    {original_video_sha256:media.sha256,bytes:media.bytes,fps:5},...content.parts.slice(1)]}:content)};
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
export function echoesMediaSecret(value: unknown, media: PreparedVideo): boolean {
  if(!('fileData' in media.part))return false;
  const uri=media.part.fileData.fileUri, encoded=JSON.stringify(value)??'';
  const signature=new URL(uri).searchParams.get('X-Amz-Signature');
  return encoded.includes(uri) || (!!signature && encoded.includes(signature));
}
