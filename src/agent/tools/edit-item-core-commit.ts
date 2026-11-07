import type { AgentContext } from '../context';
import { applyGeneric } from './edit-item-generic';
import { replaceTimelineItemAsset } from './edit-item-pool-replacement';
import type { OpResult } from './edit-item-generic-result';

export function commitMediaPlan(ctx: AgentContext, plan: OpResult): OpResult {
  const asset = (ctx.getDoc().assets ?? []).find((item) => item.id === plan.assetId);
  if (!asset) return { error: `pool asset vanished: ${String(plan.assetId)}` };
  const placed = typeof plan.durationInFrames === 'number'
    ? { ...asset, durationInFrames: Number(plan.durationInFrames) }
    : asset;
  const itemId = ctx.commands.addMediaItem(placed, {
    track: plan.track as string,
    startFrame: plan.startFrame as number | undefined,
    srcInFrame: plan.srcInFrame as number | undefined,
  });
  return {
    ok: true,
    kind: plan.kind,
    placed: {
      assetId: asset.id,
      itemId,
      name: asset.name,
      kind: asset.kind,
      track: plan.track,
      startFrame: plan.startFrame ?? 'appended',
      durationInFrames: placed.durationInFrames,
      srcInFrame: plan.srcInFrame,
    },
  };
}

export function commitTextPlan(ctx: AgentContext, plan: OpResult, ripple: boolean): OpResult {
  const itemId = ctx.commands.addTextClip({
    track: plan.track as string | undefined,
    startFrame: plan.startFrame as number | undefined,
    durationInFrames: plan.durationInFrames as number | undefined,
    ripple,
    name: plan.name as string | undefined,
    text: plan.text as string | undefined,
    fontSize: plan.fontSize as number | undefined,
    color: plan.color as string | undefined,
    fontWeight: plan.fontWeight as number | undefined,
    align: plan.align as 'left' | 'center' | 'right' | undefined,
  });
  return {
    ok: true,
    kind: 'text',
    placed: {
      itemId,
      name: plan.name ?? '文字',
      text: plan.text,
      track: plan.track,
      startFrame: plan.startFrame ?? 'appended',
      durationInFrames: plan.durationInFrames ?? 90,
      color: plan.color,
      fontSize: plan.fontSize,
    },
    ripple,
  };
}

export function commitSolidPlan(ctx: AgentContext, plan: OpResult, ripple: boolean): OpResult {
  const itemId = ctx.commands.addSolidItem({
    track: plan.track as string | undefined,
    startFrame: plan.startFrame as number | undefined,
    durationInFrames: plan.durationInFrames as number | undefined,
    color: plan.color as string | undefined,
    name: plan.name as string | undefined,
    ripple,
  });
  return {
    ok: true,
    kind: 'solid',
    placed: {
      itemId,
      name: plan.name ?? '纯色',
      color: plan.color ?? '#1a1a1a',
      track: plan.track,
      startFrame: plan.startFrame ?? 'appended',
      durationInFrames: plan.durationInFrames ?? 150,
    },
    ripple,
  };
}

export function commitPoolAssetReplacement(ctx: AgentContext, plan: OpResult): OpResult {
  const doc = ctx.getDoc();
  const asset = doc.assets.find((candidate) => candidate.id === plan.assetId);
  if (!asset) return { error: `pool asset vanished: ${String(plan.assetId)}` };
  const next = replaceTimelineItemAsset(doc, doc.activeTimelineId, String(plan.itemId), asset, {
    durationInFrames: Number(plan.durationInFrames),
    srcInFrame: typeof plan.srcInFrame === 'number' ? plan.srcInFrame : undefined,
  });
  ctx.commands.applyDoc(next);
  if (plan.genericUpdate) {
    const updated = applyGeneric(plan.genericUpdate as OpResult, ctx.commands);
    if (!updated?.ok || updated.error) return updated ?? { error: 'invalid replacement update' };
  }
  const committed = ctx.getState().items.find((item) => item.id === plan.itemId);
  return {
    ok: true,
    plan: 'replacePoolAsset',
    itemId: plan.itemId,
    assetId: asset.id,
    kind: asset.kind,
    track: committed?.track,
    startFrame: committed?.startFrame,
    durationInFrames: plan.durationInFrames,
    sourceStartFrame: plan.sourceStartFrame,
    sourceDurationInFrames: plan.sourceDurationInFrames,
  };
}
