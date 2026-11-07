// The original QA detail was discarded. Reports here are explicit synthetic
// positive/negative controls; only the observed note comes from that failure.
import assert from 'node:assert/strict';
import { execExportQaTool } from './export-qa-tools';
import { isFailedToolResult } from '../toolFailure';
import type { AgentContext } from '../context';
const ctx = { getState: () => ({ fps: 30, width: 576, height: 1024, items: [], tracks: {} }),
  getDoc: () => ({ assets: [], timelines: [] }), commands: {}, templates: [], audio: [] } as unknown as AgentContext;
const report = { ok: false, durationSeconds: 102.367, width: 576, height: 1024, fps: 30,
  hasAudio: true, hasVideo: true, blackFrames: [], frozenFrames: [], silence: [],
  issues: [{ code: 'synthetic_black_frame', severity: 'error', message: 'Synthetic negative control', startSeconds: 2, endSeconds: 3 }],
  summary: { errors: 1, warnings: 0 } };
const originalFetch = globalThis.fetch;
let requests = 0;
let payload: unknown = { report, evidence: { base64: 'ZmFrZS1qcGVn' } };
let http = 200;
globalThis.fetch = async url => {
  assert.equal(url, '/api/export-qa'); requests++;
  return Response.json(payload, { status: http });
};
const run = () => execExportQaTool('verify_export', { src: '/media/uploads/synthetic.mp4' }, ctx) as Promise<any>;
let cases = 0;
try {
  const failedQa = await run();
  assert.equal(isFailedToolResult(failedQa), false, 'completed QA must remain readable instead of becoming its image caption');
  assert.equal(failedQa.ok, true); assert.equal(failedQa.qa_passed, false);
  assert.equal(failedQa.full_film_accepted, false);
  assert.deepEqual(failedQa.report, report); assert.equal(failedQa.__images[0].base64, 'ZmFrZS1qcGVn'); cases++;
  for (const warning of [false, true]) {
    const positive = { ...report, ok: true, issues: warning ? [{ code: 'synthetic_warning', severity: 'warning', message: 'Review this warning' }] : [], summary: { errors: 0, warnings: warning ? 1 : 0 } };
    payload = { report: positive };
    const read = await run(); assert.equal(read.ok, true); assert.equal(read.qa_passed, true);
    assert.equal(read.full_film_accepted, false); assert.deepEqual(read.report, positive); cases++;
  }
  for (const malformed of [null, {}, { ...report, ok: true }, { ...report, fps: undefined }, { ...report, issues: 'bad' },
    { ...report, summary: { errors: 0, warnings: 0 } }, { ...report, durationSeconds: -1 }]) {
    payload = { report: malformed }; const read = await run();
    assert.equal(isFailedToolResult(read), true, JSON.stringify(malformed)); assert.notEqual(read.qa_passed, true); cases++;
  }
  http = 500; payload = { error: 'synthetic HTTP failure', report };
  assert.match((await run()).error, /synthetic HTTP failure/); cases++;
  http = 200; payload = { ok: false, error: 'synthetic service failure', report };
  assert.match((await run()).error, /synthetic service failure/); cases++;
  globalThis.fetch = async () => { requests++; throw new Error('synthetic connection failure'); };
  assert.match((await run()).error, /synthetic connection failure/); cases++;
  assert.equal(requests, cases, 'one fake request per invocation; no automatic retry');
  console.log(`qa-readback.verify: ${cases} cases passed, fake fetch only`);
} finally { globalThis.fetch = originalFetch; }
