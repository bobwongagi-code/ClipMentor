/** Portable ASR evidence only. Milliseconds from the provider are converted once on the server. */
export const FUNASR_MODEL = 'fun-asr-flash-2026-06-15';
export const ASR_AUDIO = { format: 'mp3', sample_rate: 16000, channels: 1, bitrate: 64000 } as const;
export const ASR_CHUNK_SECONDS = 240;
export const ASR_OVERLAP_SECONDS = 2;
export const ASR_MAX_BYTES = 8_000_000;
export interface SourceWord { text: string; start_seconds: number; end_seconds: number }
export interface AsrChunk {
  chunk_id: string;
  offset_seconds: number;
  end_seconds: number;
  status: 'completed' | 'failed' | 'not_requested';
  audio_bytes: number;
  audio_sha256: string;
  words: SourceWord[];
  detected_language: string | null;
  request_id?: string;
  http_status?: number;
  failure_stage?: 'network' | 'http' | 'json' | 'timestamps';
  separator_entries_skipped?: number;
  error?: string;
}
export interface SourceTranscription {
  schema_version: 1;
  operation_id: string;
  provider: 'fun-asr';
  model: typeof FUNASR_MODEL;
  requested_language: string;
  detected_language: string | null;
  source_hash: string;
  duration_seconds: number;
  fps: number;
  audio: typeof ASR_AUDIO;
  status: 'completed' | 'partial' | 'failed';
  requests_attempted: number;
  chunks: AsrChunk[];
  words: SourceWord[];
  conflicts: Array<{ range_seconds: [number, number]; chunk_ids: [string, string] }>;
  issues: string[];
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const words = (v: unknown): v is SourceWord[] => Array.isArray(v) && v.every((w) => obj(w)
  && typeof w.text === 'string' && !!w.text.trim() && num(w.start_seconds) && num(w.end_seconds) && w.end_seconds >= w.start_seconds);
export function isSourceTranscription(v: unknown): v is SourceTranscription {
  const audio = obj(v) && obj(v.audio) ? v.audio : {};
  return obj(v) && v.schema_version === 1 && typeof v.operation_id === 'string'
    && /^[a-f0-9-]{36}$/.test(v.operation_id) && v.provider === 'fun-asr' && v.model === FUNASR_MODEL
    && typeof v.requested_language === 'string' && /^(auto|[a-z]{2,3})$/.test(v.requested_language)
    && (v.detected_language === null || typeof v.detected_language === 'string')
    && hash(v.source_hash) && num(v.duration_seconds) && v.duration_seconds > 0 && num(v.fps) && v.fps > 0
    && obj(v.audio) && Object.entries(ASR_AUDIO).every(([k, value]) => audio[k] === value)
    && (typeof v.status === 'string' && ['completed', 'partial', 'failed'].includes(v.status))
    && Number.isSafeInteger(v.requests_attempted) && Number(v.requests_attempted) >= 0 && words(v.words)
    && Array.isArray(v.chunks) && v.chunks.every((c) => obj(c) && typeof c.chunk_id === 'string'
      && num(c.offset_seconds) && num(c.end_seconds) && c.end_seconds > c.offset_seconds
      && (typeof c.status === 'string' && ['completed', 'failed', 'not_requested'].includes(c.status)) && num(c.audio_bytes)
      && c.audio_bytes <= ASR_MAX_BYTES && hash(c.audio_sha256) && words(c.words)
      && (c.detected_language === null || typeof c.detected_language === 'string')
      && (c.request_id === undefined || typeof c.request_id === 'string') && (c.error === undefined || typeof c.error === 'string')
      && (c.http_status === undefined || (Number.isInteger(c.http_status) && Number(c.http_status) >= 100 && Number(c.http_status) <= 599))
      && (c.failure_stage === undefined || (typeof c.failure_stage === 'string' && ['network', 'http', 'json', 'timestamps'].includes(c.failure_stage)))
      && (c.separator_entries_skipped === undefined || (Number.isSafeInteger(c.separator_entries_skipped) && Number(c.separator_entries_skipped) >= 0)))
    && Array.isArray(v.conflicts) && v.conflicts.every((c) => obj(c) && Array.isArray(c.range_seconds)
      && c.range_seconds.length === 2 && c.range_seconds.every(num) && c.range_seconds[1] > c.range_seconds[0]
      && Array.isArray(c.chunk_ids) && c.chunk_ids.length === 2 && c.chunk_ids.every((id) => typeof id === 'string'))
    && Array.isArray(v.issues) && v.issues.every((s) => typeof s === 'string');
}

export function planAsrChunks(duration: number): Array<[number, number]> {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid source duration');
  const chunks: Array<[number, number]> = [];
  for (let start = 0; start < duration;) {
    const end = Math.min(duration, start + ASR_CHUNK_SECONDS);
    chunks.push([start, end]);
    if (end === duration) break;
    start = end - ASR_OVERLAP_SECONDS;
  }
  return chunks;
}

/** Remove only exact overlap text matches. Conflicting alternatives remain in the chunk records. */
export function stitchAsrChunks(chunks: AsrChunk[]): Pick<SourceTranscription, 'words' | 'conflicts'> {
  const conflicts: SourceTranscription['conflicts'] = [];
  const retained = chunks.map((c) => c.words.slice());
  for (let i = 1; i < chunks.length; i++) {
    const left = chunks[i - 1], right = chunks[i];
    if (left.status !== 'completed' || right.status !== 'completed') continue;
    const start = right.offset_seconds, end = left.end_seconds;
    const inOverlap = (w: SourceWord) => (w.start_seconds + w.end_seconds) / 2 >= start && (w.start_seconds + w.end_seconds) / 2 < end;
    const a = left.words.filter(inOverlap), b = right.words.filter(inOverlap);
    const same = a.length === b.length && a.every((w, j) => w.text === b[j].text);
    if (!same) conflicts.push({ range_seconds: [start, end], chunk_ids: [left.chunk_id, right.chunk_id] });
    // In a conflict neither interpretation enters the canonical transcript; both remain inspectable.
    retained[i] = retained[i].filter((w) => !inOverlap(w));
    if (!same) retained[i - 1] = retained[i - 1].filter((w) => !inOverlap(w));
  }
  return { words: retained.flat().sort((a, b) => a.start_seconds - b.start_seconds), conflicts };
}
