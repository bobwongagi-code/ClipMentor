import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  buildPreviewReviewRequest, reviewClipMentorPreview, validatePreviewReviewInput,
  PREVIEW_REVIEW_ENDPOINT,
} from './preview-review.ts';
import { postSourceVideoTransport, SourceVideoTransportError } from './source-video-transport.ts';
import type { SourceVideoTransportDiagnostic } from '../../shared/clipmentor-source-video.ts';

const args = process.argv.slice(2);
const options: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--video', '--input', '--out', '--operation'].includes(args[i]) || !args[i + 1]
    || options[args[i]]) throw new Error('Use --video MP4 --input JSON --out JSON --operation UUID');
  options[args[i]] = args[i + 1];
}
if (Object.keys(options).length !== 4 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options['--operation'])) {
  throw new Error('All four arguments and a UUID v4 operation are required');
}
try { process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local')); } catch { /* server environment is also supported */ }
const key = process.env.ROOTIFY_GATEWAY_API_KEY ?? '';
if (!key.trim() || /[\r\n]/.test(key)) throw new Error('Preview review server credential unavailable');
const video = await readFile(resolve(options['--video']));
const input = validatePreviewReviewInput(JSON.parse(await readFile(resolve(options['--input']), 'utf8')));
const prepared = buildPreviewReviewRequest(video, input); // Preflight before reserving or incurring charges.
const output = resolve(options['--out']);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const ledger = join(dirname(output), `${options['--operation']}.operation.json`);
const fingerprint = createHash('sha256').update(PREVIEW_REVIEW_ENDPOINT + prepared.version + prepared.request_sha256).digest('hex');
if (await access(output).then(() => true, () => false)) {
  const prior = await readFile(ledger, 'utf8').catch(() => null);
  if (!prior) throw new Error('Output already exists; no request sent');
}
try {
  await writeFile(ledger, JSON.stringify({ status: 'reserved', fingerprint, requests_attempted: 1 }), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Could not reserve review operation');
  const prior = JSON.parse(await readFile(ledger, 'utf8'));
  if (prior.fingerprint !== fingerprint) throw new Error('Operation belongs to different review input');
  if (prior.status !== 'completed') throw new Error('Prior attempt pending or failed; no automatic replay');
  console.log(JSON.stringify({ status: 'cached', output: prior.output, requests_sent: 0 }));
  process.exit(0);
}
let diagnostic: SourceVideoTransportDiagnostic | undefined;
try {
  const result = await reviewClipMentorPreview(video, input, { key, post: async (body, credential, signal) => {
    try { return await postSourceVideoTransport(body, credential, signal, options['--operation'], tmpdir()); }
    catch (error) {
      if (error instanceof SourceVideoTransportError) diagnostic = error.diagnostic;
      throw error;
    }
  } });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(ledger, JSON.stringify({ status: 'completed', fingerprint, requests_attempted: 1, output }), { mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, output, requests_attempted: 1, full_film_accepted: false }));
} catch (error) {
  const message = error instanceof Error && /^(Preview review|Invalid preview|Inline request)/.test(error.message)
    && !error.message.includes(key) ? error.message : 'Review failed; inspect operation record, no automatic retry';
  await writeFile(ledger, JSON.stringify({ status: 'failed', fingerprint, requests_attempted: 1, error: message, ...(diagnostic ? { transport_diagnostic: diagnostic } : {}) }), { mode: 0o600 });
  console.error(message);
  process.exitCode = 1;
}
