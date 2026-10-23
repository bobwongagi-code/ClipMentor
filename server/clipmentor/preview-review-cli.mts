import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  buildPreviewReviewRequest, reviewClipMentorPreview, validatePreviewReviewInput,
  PREVIEW_REVIEW_ENDPOINT, PREVIEW_REVIEW_TIMEOUT_MS,
} from './preview-review.ts';

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
try {
  const result = await reviewClipMentorPreview(video, input, { key, post: async (body, credential, signal) => {
    const directory = await mkdtemp(join(tmpdir(), 'clipmentor-review-'));
    try {
      const request = join(directory, 'request.json'), response = join(directory, 'response.json');
      await writeFile(request, body, { mode: 0o600 });
      const status = await new Promise<number>((accept, reject) => {
        const child = spawn('curl', ['--disable', '-sS', '--http1.1', '--noproxy', '*', '--proto', '=https',
          '--max-redirs', '0', '--retry', '0', '--connect-timeout', '30', '--max-time', String(PREVIEW_REVIEW_TIMEOUT_MS / 1000),
          '--max-filesize', '1048576', '-H', '@-', '-H', 'Content-Type: application/json',
          '-H', `Idempotency-Key: ${options['--operation']}`, '--data-binary', `@${request}`,
          '--output', response, '--write-out', '%{http_code}', PREVIEW_REVIEW_ENDPOINT],
        { stdio: ['pipe', 'pipe', 'ignore'], signal });
        let code = '';
        child.stdout.on('data', (chunk) => { if (code.length < 16) code += String(chunk); });
        child.on('error', () => reject(new Error('Transport failed')));
        child.on('close', (exit) => exit === 0 && /^\d{3}$/.test(code) ? accept(Number(code)) : reject(new Error('Transport failed')));
        child.stdin.on('error', () => undefined);
        child.stdin.end(`Authorization: Bearer ${credential}\n`);
      });
      let responseBody: unknown = null;
      if (status === 200) { try { responseBody = JSON.parse(await readFile(response, 'utf8')); } catch { /* safely rejected by parser */ } }
      return { status, body: responseBody };
    } finally { await rm(directory, { recursive: true, force: true }); }
  } });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(ledger, JSON.stringify({ status: 'completed', fingerprint, requests_attempted: 1, output }), { mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, output, requests_attempted: 1, full_film_accepted: false }));
} catch (error) {
  const message = error instanceof Error && /^(Preview review|Invalid preview|Inline request)/.test(error.message)
    && !error.message.includes(key) ? error.message : 'Review failed; inspect operation record, no automatic retry';
  await writeFile(ledger, JSON.stringify({ status: 'failed', fingerprint, requests_attempted: 1, error: message }), { mode: 0o600 });
  console.error(message);
  process.exitCode = 1;
}
