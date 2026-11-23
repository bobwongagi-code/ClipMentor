import type { TimelineItem } from '../editor/types';
import { ALL_FX } from './fx/effects';
import { timelineFxDefinition, type TimelineFxDefinitions } from './fx/uniforms';

export function glEffects(item: TimelineItem, definitions?: TimelineFxDefinitions) {
  return (item.effects ?? []).flatMap(fx => {
    const def = timelineFxDefinition(fx.assetId, definitions, ALL_FX);
    return def ? [{ fx, def }] : [];
  });
}

/** The first stack entry whose assetId is a registered GL effect. */
export function firstGlEffect(item: TimelineItem, definitions?: TimelineFxDefinitions) {
  return glEffects(item, definitions)[0] ?? null;
}
