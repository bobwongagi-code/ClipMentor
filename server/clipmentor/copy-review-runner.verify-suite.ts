import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CopyReviewError, runIsolatedCodexReview } from './copy-review';

export async function verifyIsolatedCopyReviewRunner(root: string, goodRaw: () => unknown) {
  // Exercise the actual isolated runner against a fake Codex RPC executable.
  // Assert fresh/read-only thread setup and real image transport, without invoking Codex/model.
  const executable = join(root, 'fake-codex');
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex 0.146.0'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const answer = ${JSON.stringify(goodRaw())};
let testPrompt = '', expectedBatches = 1, batchIndex = 0, frameTotal = 1;
const done = () => {
  send({method:'item/agentMessage/delta',params:{threadId:'isolated',turnId:'one',delta:testPrompt.includes('BAD_JSON') ? '{invalid' : JSON.stringify(answer)}});
  send({method:'turn/completed',params:{threadId:'isolated',turn:{id:'one',status:'completed'}}});
};
createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{}});
  if (m.method === 'thread/start') {
    if (!m.params.ephemeral || m.params.cwd !== null || m.params.sandbox !== 'read-only'
      || m.params.dynamicTools.length !== 1 || m.params.dynamicTools[0].name !== 'read_review_frames'
      || m.params.config.features.unified_exec !== false) process.exit(81);
    expectedBatches = m.params.dynamicTools[0].inputSchema.properties.batch.maximum + 1;
    return send({id:m.id,result:{thread:{id:'isolated'}}});
  }
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'one'}}});
    testPrompt = m.params.input[0].text;
    frameTotal = Number(testPrompt.match(/FRAME_COUNT=(\\d+)/)?.[1] ?? ((expectedBatches - 1) * 8 + 1));
    if (testPrompt.includes('MODEL_ERROR')) {
      send({method:'error',params:{threadId:'isolated',turnId:'one',error:{message:'synthetic failure'},willRetry:false}});
      return;
    }
    if (testPrompt.includes('SKIP_FRAMES')) return done();
    return send({id:'frames',method:'item/tool/call',params:{threadId:'isolated',turnId:'one',callId:'read-one',tool:'read_review_frames',arguments:{batch:testPrompt.includes('BAD_BATCH') ? -1 : 0}}});
  }
  if (m.id === 'frames') {
    if (testPrompt.includes('BAD_BATCH')) {
      if (m.result.success !== false) process.exit(83);
      return done();
    }
    const payload = JSON.parse(m.result.contentItems[0].text);
    if (!m.result.success || m.result.contentItems.length !== 1 || m.result.contentItems[0].type !== 'inputText'
      || !payload.metadata.note.includes('U1/original') || payload.content.length !== Math.min(8, frameTotal - batchIndex * 8)
      || payload.content[0].type !== 'image' || payload.content[0].mimeType !== 'image/jpeg'
      || payload.content[0].data !== 'aGVsbG8=') process.exit(82);
    batchIndex++;
    if (testPrompt.includes('READ_ALL') && batchIndex < expectedBatches) return send({id:'frames',method:'item/tool/call',params:{threadId:'isolated',turnId:'one',callId:'read-'+batchIndex,tool:'read_review_frames',arguments:{batch:batchIndex}}});
    return done();
  }
  if (m.id !== undefined) send({id:m.id,result:{}});
});
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const priorPath = process.env.OPENCHATCUT_CODEX_PATH;
  process.env.OPENCHATCUT_CODEX_PATH = executable;
  try {
    const frames = [{ unit_id: 'U1', phase: 'original' as const, source_seconds: 60, base64: 'aGVsbG8=' }];
    assert.deepEqual(await runIsolatedCodexReview('transport test', frames, 'test-isolated', 'test-project', AbortSignal.timeout(15_000)), goodRaw());
    for (const [prompt, expectedCode, delivered, invalidCalls] of [
      ['SKIP_FRAMES', 'frame_inspection_incomplete', 0, 0],
      ['BAD_BATCH', 'frame_inspection_incomplete', 0, 1],
      ['BAD_JSON', 'response_not_json', 1, 0],
      ['MODEL_ERROR', 'model_turn_failed', 0, 0],
    ] as const) {
      await assert.rejects(runIsolatedCodexReview(prompt, frames, `test-${prompt}`, 'test-project', AbortSignal.timeout(15_000)), (e: unknown) => {
        assert(e instanceof CopyReviewError);
        assert.equal(e.diagnostic.code, expectedCode);
        assert.equal(e.diagnostic.inspection!.deliveredBatches, delivered);
        assert.equal(e.diagnostic.inspection!.invalidBatchCalls, invalidCalls);
        if (prompt === 'BAD_JSON') assert.equal(e.rawOutput, '{invalid');
        return true;
      });
    }
    assert.deepEqual(await runIsolatedCodexReview('READ_ALL FRAME_COUNT=32', Array(32).fill(frames[0]), 'test-current-volume', 'test-project', AbortSignal.timeout(15_000)), goodRaw(), 'current revision171 volume: four image batches can complete without a model');
    assert.deepEqual(await runIsolatedCodexReview('READ_ALL', [...frames, ...Array(8).fill(frames[0])], 'test-full', 'test-project', AbortSignal.timeout(15_000)), goodRaw());
    await assert.rejects(runIsolatedCodexReview('transport test', [...frames, ...Array(8).fill(frames[0])], 'test-partial', 'test-project', AbortSignal.timeout(15_000)), (e: unknown) => {
      assert(e instanceof CopyReviewError);
      assert.equal(e.diagnostic.code, 'frame_inspection_incomplete');
      assert.equal(e.diagnostic.inspection!.expectedBatches, 2);
      assert.equal(e.diagnostic.inspection!.deliveredBatches, 1);
      return true;
    });
  } finally {
    if (priorPath === undefined) delete process.env.OPENCHATCUT_CODEX_PATH;
    else process.env.OPENCHATCUT_CODEX_PATH = priorPath;
  }
}
