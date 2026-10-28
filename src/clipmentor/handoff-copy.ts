import { handoffRecord } from '../../shared/clipmentor-handoff';
import type { AgentContext } from '../agent/context';
import { captionsOnTrack, defaultTrackId, resolveTrackId } from '../editor/types';
import { resolveCaptionWords, resolveCaptionWordIndices, resolveCaptionWordRefs, applyWordOverrides } from '../captions/resolve';
import { applyDisplayTextEntries } from '../agent/tools/captions-word-overrides';

const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim();
/** Exact frozen text accounting only. Does not judge language or raster/code-generated text. */
export function assertHandoffCopy(name: string, args: Record<string, unknown>, ctx: AgentContext): void {
  const allowed = new Set<string>();
  const add = (v: unknown) => { if (typeof v === 'string' && normalized(v)) allowed.add(normalized(v)); };
  for (const unit of ctx.getDoc().clipMentorAnalysis?.blueprint ?? []) {
    const internal = (unit as unknown as Record<string, unknown>).internal_review;
    if (!handoffRecord(internal)) continue;
    const candidate = internal[String(internal.current_script_candidate)];
    if (!handoffRecord(candidate) || !Array.isArray(candidate.lines)) continue;
    const group: string[] = [];
    for (const line of candidate.lines.filter(handoffRecord)) {
      add(line.narration_ms);
      if (Array.isArray(line.caption_lines)) {
        line.caption_lines.forEach(add);
        const joined = line.caption_lines.filter(v => typeof v === 'string').join(' ');
        add(joined); group.push(joined);
      }
      if (Array.isArray(line.labels)) line.labels.forEach(v => { add(v); if (handoffRecord(v)) add(v.text); });
    }
    add(group.join(' '));
    const plan = internal[String(internal.current_picture_plan)];
    if (handoffRecord(plan) && handoffRecord(plan.viewer_stage_cues)) {
      const cues = plan.viewer_stage_cues;
      if (handoffRecord(cues.original)) add(cues.original.text);
      if (Array.isArray(cues.revisit)) cues.revisit.filter(handoffRecord).forEach(v => add(v.text));
    }
  }
  if (name === 'edit_captions' && args.action === 'display_text') {
    const json = typeof args.json === 'string' ? JSON.parse(args.json) : args.json;
    if (!handoffRecord(json)) throw new Error('handoff_caption_input_invalid');
    const state = ctx.getState();
    const requested = String(args.captionTrackId || args.captionsItemId || '');
    const target = requested ? resolveTrackId(state, requested, 'caption') : defaultTrackId(state, 'caption');
    const captions = target ? captionsOnTrack(state, target) : state.captions;
    if (!captions) throw new Error('handoff_caption_source_missing');
    const next = json.clearOverrides === true || json.clear_overrides === true ? {} : applyDisplayTextEntries(Array.isArray(json.overrides) ? json.overrides : [], captions, state.items, state.fps).wordOverrides;
    const words = resolveCaptionWords(captions, state.items, state.fps);
    const indices = resolveCaptionWordIndices(captions, state.items, state.fps);
    const refs = resolveCaptionWordRefs(captions, state.items, state.fps);
    const visible = (overrides: typeof captions.wordOverrides) => normalized(applyWordOverrides(words, indices, overrides, refs).words.map(w => w.text).join(' '));
    if (visible(next) !== visible(captions.wordOverrides) && !allowed.has(visible(next))) throw new Error('handoff_caption_text_not_frozen');
    return;
  }
  // Plain text additions and generic property replacements must reuse frozen copy/short labels.
  // Layout/timing/style fields are deliberately not interpreted as prose.
  const check = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(check); return; }
    if (!handoffRecord(v)) return;
    for (const [key, value] of Object.entries(v)) {
      if (key === 'text' && (typeof value !== 'string' || !allowed.has(normalized(value)))) throw new Error('handoff_caption_text_not_frozen');
      if (typeof value === 'object') check(value);
    }
  };
  if (['edit_item', 'update_item_props', 'edit_track'].includes(name)) check(args);
}
