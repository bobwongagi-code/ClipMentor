import assert from 'node:assert/strict';
import fixture from './fixtures/barely-there-mg-replacement-20261030.json';
import { makeDraft } from '../../editor/store';
import type { ProjectDoc } from '../../editor/types';
import { resolveTrackId } from '../../editor/types';
import { execEditItemTool } from './edit-item-tools';
import { checkCopyProduction } from '../../clipmentor/production-gate';
import { executeTool } from '../tools';

const before = fixture.before as unknown as ProjectDoc;
const args = fixture.args;
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async () => { requests++; throw new Error('Network forbidden'); };
const context = () => ({ ...makeDraft(structuredClone(before)), templates: [], audio: [], getCreativeMode: () => 'clipmentor' });
let cases = 0;
try {
  // Preserve the real historical receipt: it is stale on the current gate, not a fresh production approval.
  const historicalGate=await checkCopyProduction(before,'clipmentor');
  assert.equal(historicalGate.allowed,false);assert.equal(historicalGate.code,'copy_review_stale');
  const gated=context();const gatedResult=await executeTool('edit_item',args,gated) as any;
  assert(gatedResult.error,'the production dispatcher must not admit this historical snapshot');
  assert.deepEqual(gated.getDoc(),before);cases++;
  const stale = context(); const staleDoc = structuredClone(before); staleDoc.clipMentorAnalysis!.revision++;
  stale.commands.applyDoc(staleDoc);
  const blocked = await executeTool('edit_item', args, stale) as any;
  assert(blocked.error, 'the production entry still rejects a stale review');
  assert.deepEqual(stale.getDoc(), staleDoc); cases++;
  const ctx = context();
  // Exercise the mutation primitive independently; these cases do not manufacture a current review.
  const dry = await execEditItemTool('edit_item', args, ctx) as any;
  assert.equal(dry.ok, true, JSON.stringify(dry)); cases++;
  assert.deepEqual(ctx.getDoc(), before, 'validateOnly cannot publish edits');
  const swapOnly = context();
  const swap = await execEditItemTool('edit_item', { updates: [{ type: 'motion-graphic', itemId: args.updates[0]!.itemId, assetId: args.updates[0]!.assetId }] }, swapOnly) as any;
  assert.equal(swap.ok, true); cases++;
  const swapped = swapOnly.getState().items.find(i => i.id === args.updates[0]!.itemId)!;
  assert.deepEqual(swapped.props, before.assets.find(a => a.id === args.updates[0]!.assetId)!.props ?? {}, 'old source props must not leak into the new source');
  const result = await execEditItemTool('edit_item', { ...args, validateOnly: false }, ctx) as any;
  assert.equal(result.ok, true, JSON.stringify(result)); cases++;
  assert.deepEqual(ctx.getDoc().clipMentorAnalysis, before.clipMentorAnalysis, 'no review, counter or approval is synthesized');
  for (const update of args.updates.filter(u => u.type === 'motion-graphic')) {
    const item = ctx.getState().items.find(i => i.id === update.itemId)!;
    const old = before.timelines[0]!.items.find(i => i.id === update.itemId)!;
    const asset = before.assets.find(a => a.id === update.assetId)!;
    assert.equal(item.templateId, asset.id); assert.equal(item.sourceAssetId, asset.id);
    assert.equal(item.code, asset.code); assert.deepEqual(item.props, { ...asset.props, ...update.props });
    assert.equal(item.startFrame, old.startFrame); assert.equal(item.durationInFrames, old.durationInFrames);
    assert.equal(item.track, 'track' in update ? resolveTrackId(ctx.getState(), update.track, 'video') : old.track);
  }
  const changed = new Set([...args.updates.map(u => u.itemId), ...args.deletes.map(d => d.itemId)]);
  for (const item of before.timelines[0]!.items.filter(i => !changed.has(i.id))) {
    assert.deepEqual(ctx.getState().items.find(i => i.id === item.id), item, 'middle/audio and unrelated clips retained');
  }
  const mg = args.updates[0]!;
  for (const patch of [
    { assetId: 'not-found' },
    { assetId: before.assets.find(a => a.kind === 'image')!.id },
    { props: [] }, { props: { invalid: Number.NaN } },
    { track: 'A1' }, { type: 'image' }, { typo: true }, { sourceStartFrame: 4 }, { playbackRate: 0.5 },
  ]) {
    const bad = context();
    const failed = await execEditItemTool('edit_item', {
      updates: [{ type: 'motion-graphic', itemId: args.updates[1]!.itemId, props: { staged: true } }, { ...mg, ...patch }],
    }, bad) as any;
    assert.equal(failed.ok, false, JSON.stringify(patch));
    assert.deepEqual(bad.getDoc(), before, 'a failed batch loses no saved edit and publishes no partial change'); cases++;
  }
  const missingCode = context();
  const doc = structuredClone(before); doc.assets.find(a => a.id === mg.assetId)!.code = '';
  missingCode.commands.applyDoc(doc);
  assert.equal((await execEditItemTool('edit_item', { updates: [mg] }, missingCode) as any).ok, false); cases++;
  const missingImage = context();
  const native = before.timelines[0]!.items.find(i => i.kind === 'image' && i.startFrame === 0);
  assert(native, 'fixture must exercise a registered native picture');
  const protectedResult = await execEditItemTool('edit_item', { updates: [mg], deletes: [{ type: 'image', itemId: native.id }] }, missingImage) as any;
  assert.equal(protectedResult.ok, false); assert.match(protectedResult.error, /delivery_native_picture/);
  assert.deepEqual(missingImage.getDoc(), before); cases++;
  const ambiguous = context(); const ambiguousDoc = structuredClone(before);
  const original = ambiguousDoc.assets.find(a => a.id === mg.assetId)!;
  ambiguousDoc.assets.push({ ...original, id: original.id + '-duplicate' }); ambiguous.commands.applyDoc(ambiguousDoc);
  const ambiguousResult = await execEditItemTool('edit_item', { updates: [{ ...mg, assetId: original.id.slice(0, 8) }] }, ambiguous) as any;
  assert.equal(ambiguousResult.ok, false); assert.match(ambiguousResult.error, /ambiguous/);
  assert.deepEqual(ambiguous.getDoc(), ambiguousDoc); cases++;
  const prefix = context();
  const unique = await execEditItemTool('edit_item', { updates: [{ ...mg, assetId: original.id.slice(0, 8) }] }, prefix) as any;
  assert.equal(unique.ok, true); cases++;
  const aborted = context();
  const cancelled = await execEditItemTool('edit_item', { updates: [mg] }, { ...aborted, getAgentRunSignal: () => AbortSignal.abort() }) as any;
  assert.equal(cancelled.ok, false); assert.deepEqual(aborted.getDoc(), before); cases++;
  assert.equal(requests, 0);
  console.log(`mg-replacement.verify: ${cases} cases passed, zero network`);
} finally { globalThis.fetch = originalFetch; }
