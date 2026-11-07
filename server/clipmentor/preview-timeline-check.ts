import { checkTransitionManifest, type Scene, type PictureLayer } from '../../src/clipmentor/transition-check.ts';
import { evaluatePreviewTeachingJudgment, validatePreviewReviewInput, type PreviewTeachingJudgment, type ReviewReceipt } from './preview-review.ts';

type Manifest = { fps: number; total_frames: number; scenes: Scene[] };
type ActualSegment = {scene_index:number;start_seconds:number;end_seconds:number;duration_seconds:number;kind:string;label:string|null;
  source_start_seconds:number|number[]|null;source_end_exclusive_seconds:number|null;scheduled_composition:boolean;layer:PictureLayer|null};
type Observation = ReviewReceipt & { path: string };
type IssueCode = 'static_description_over_video' | 'possible_dynamic_omission' | 'pause_not_separately_described'
  | 'pause_used_in_positive_evidence' | 'wording_requires_evidence';

/** Teaching spans are saved output positions, not mechanically generated transition IDs.
 * Legacy transition reviews keep their original computed grouping and immutable receipts. */
export function previewReviewWindows(manifest: unknown, inputValue: unknown) {
  const structural=checkTransitionManifest(manifest),input=validatePreviewReviewInput(inputValue);
  if(input.duration_seconds!==structural.duration_seconds)throw new Error('Review and manifest durations differ');
  return input.units.map(unit=>{
    const range=unit.output_range_seconds;
    if(range&&/^transition-\d+$/.test(unit.unit_id))throw new Error('Cannot override computed transition review range');
    if(range)return {group_id:unit.unit_id,start_seconds:range[0],end_seconds:range[1],
      cut_events:structural.cut_events.filter(c=>c.at_seconds>=range[0]&&c.at_seconds<=range[1])};
    const group=structural.review_groups.find(g=>g.group_id===unit.unit_id);
    if(!group)throw new Error('Manifest does not match review units');
    return group;
  });
}

/** Facts are derived from the execution record. Text matching only locates explicit Chinese
 * wording for inspection; it is not a general semantic classifier or a rendered-pixel test. */
export function checkPreviewTimelineObservations(manifestValue: unknown, resultValue: unknown, inputValue: unknown) {
  const structural = checkTransitionManifest(manifestValue);
  const windows=previewReviewWindows(manifestValue,inputValue);
  const manifest = manifestValue as Manifest;
  const input = validatePreviewReviewInput(inputValue);
  if (input.duration_seconds !== structural.duration_seconds) throw new Error('Review and manifest durations differ');
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!object(resultValue) || resultValue.full_film_accepted !== false) throw new Error('Expected a saved, non-final preview review');
  const validation = evaluatePreviewTeachingJudgment(resultValue.judgment, input);
  if (validation.issues.some(i => /invalid_|missing_(coverage|continuity|front_back_evidence)|unit_point_mismatch/.test(i))) {
    throw new Error('Invalid or incomplete saved judgment');
  }
  const judgment = resultValue.judgment as PreviewTeachingJudgment;
  const fps = manifest.fps;
  const overlaps = (a: number, b: number, c: number, d: number) => Math.max(a, c) < Math.min(b, d);
  const factsBetween = (start: number, end: number) => manifest.scenes.flatMap<ActualSegment>((s, scene_index) => {
    const a = Math.max(start, s.start_frame / fps), b = Math.min(end, s.end_frame / fps);
    if (a >= b) return [];
    if(s.kind==='composition')return s.layers.map(l=>({
      scene_index,start_seconds:a,end_seconds:b,duration_seconds:b-a,
      kind:l.kind==='video'?'video':l.kind==='image'?'still':l.kind,label:s.label??null,
      source_start_seconds:l.source_start_seconds===undefined?null:l.source_start_seconds+(l.kind==='video'?(a-s.start_frame/fps)*(l.playback_rate??1):0),
      source_end_exclusive_seconds:l.kind==='video'&&l.source_start_seconds!==undefined?l.source_start_seconds+(b-s.start_frame/fps)*(l.playback_rate??1):null,
      scheduled_composition:true,layer:l,
    }));
    const moving = s.kind === 'video' || s.kind === 'original';
    const offset = moving ? a - s.start_frame / fps : 0;
    return [{ scene_index, start_seconds: a, end_seconds: b, duration_seconds: b - a,
      kind: s.kind, label: s.label ?? null, scheduled_composition:false,layer:null,source_start_seconds: Array.isArray(s.content) ? s.content : s.content + offset,
      source_end_exclusive_seconds: moving ? Number(s.content) + b - s.start_frame / fps : null }];
  });
  const units = judgment.continuity.map(unit => {
    const group = windows.find(g => g.group_id === unit.unit_id);
    if (!group) throw new Error('Review unit has no computed transition group');
    const observations: Observation[] = [];
    const add = (path: string, receipts: ReviewReceipt[]) => receipts.forEach((r, i) => observations.push({ ...r, path: `${path}[${i}]` }));
    add('previous', unit.previous); add('current', unit.current);
    add('narrative.evidence', unit.narrative.evidence); add('teaching.evidence', unit.teaching.evidence);
    for (const p of judgment.coverage.filter(p => unit.point_ids.includes(p.point_id))) {
      add(`coverage.${p.point_id}.depiction`, p.depiction); add(`coverage.${p.point_id}.teaching.evidence`, p.teaching.evidence);
    }
    const start = Math.min(group.start_seconds, ...observations.map(r => r.start_seconds));
    const end = Math.max(group.end_seconds, ...observations.map(r => r.end_seconds));
    const facts = factsBetween(start, end);
    const issues: Array<{ code: IssueCode; certainty: 'execution_description_conflict' | 'needs_semantic_check' | 'reporting_gap';
      detail: string; observations: string[]; scene_indices: number[] }> = [];
    const issue = (code: IssueCode, certainty: typeof issues[number]['certainty'], detail: string, paths: string[], indices: number[]) => {
      const prior = issues.find(i => i.code === code);
      if (prior) { prior.observations = [...new Set([...prior.observations, ...paths])]; prior.scene_indices = [...new Set([...prior.scene_indices, ...indices])];
        if (certainty === 'execution_description_conflict') prior.certainty = certainty; }
      else issues.push({ code, certainty, detail, observations: paths, scene_indices: indices });
    };
    // Only explicit visual observations are checked for medium claims. A narration quote
    // saying "show" is not a claim that the entire evidence window is static.
    const checks = observations.map(r => {
      const actual = factsBetween(r.start_seconds, r.end_seconds);
      const videos = actual.filter(s => s.kind === 'video' || s.kind === 'original');
      const visual = r.channel === 'visual_organization';
      const negated = /(?:不是|并非|不只是|并不|非|不能说)[^，。；]{0,16}(?:静|定格|两张)/.test(r.observed);
      const mixed = /(?:动态|视频|播放|video)/i.test(r.observed);
      const staticClaim = visual && !negated && !mixed && /(?:定格(?:分解|特写)?图|静帧|静图|静态卡片)/.test(r.observed);
      const imageSummary = visual && !negated && !mixed && /两张(?:回顾)?(?:图|画面)/.test(r.observed);
      // Ignore a rounded receipt edge touching the adjacent scene by less than half
      // its last decimal unit (2-decimal seconds here), not a perceptual tolerance.
      const substantialVideos = videos.filter(s => s.duration_seconds > .005 + Number.EPSILON * 16);
      const exclusiveStatic = staticClaim && /(?:全程|只有|全部|始终|仅有)/.test(r.observed);
      const hasStatic = actual.some(s => (s.kind === 'still' || s.kind === 'relation') && s.duration_seconds > .005);
      const definiteConflict = (exclusiveStatic || !hasStatic) && !substantialVideos.some(s=>s.scheduled_composition);
      if (staticClaim && substantialVideos.length) issue('static_description_over_video', definiteConflict ? 'execution_description_conflict' : 'needs_semantic_check',
        '静态描述的证据范围含动态素材；混合区间可能只是概括不全，只有排他性静态断言或全动态区间才构成明确类型冲突。多轨仅能确认安排了动态层，可能被遮挡，不能据此证明实际可见。均不等于像素/观感验收。', [r.path], substantialVideos.map(s => s.scene_index));
      if (imageSummary && substantialVideos.length) issue('possible_dynamic_omission', 'needs_semantic_check',
        '“两张回顾画面”未交代区间内的动态素材；可能是概括，不能单凭“张”断言模型没看到视频。', [r.path], substantialVideos.map(s => s.scene_index));
      const references = input.reference_text.filter(t => overlaps(r.start_seconds, r.end_seconds, t.start_seconds, t.end_seconds));
      if (/(?:洗净|洗后|清洗后|冲洗后|冲干净)/.test(r.observed)
        && references.some(t => /\bbasah\b|湿润|湿肤/i.test(t.text))
        && !references.some(t => /洗净|洗后|清洗后|冲洗后|冲干净|\b(?:bilas|dibilas|cuci|dicuci)\b/i.test(t.text))) {
        issue('wording_requires_evidence', 'needs_semantic_check',
          '模型用了清洗完成类措辞，对照文字仅明确湿润；清单不能证明有无冲洗，不能据此判定该说法为假。', [r.path], actual.map(s => s.scene_index));
      }
      return { ...r, actual_segments: actual, medium_claim_check: staticClaim ? (substantialVideos.length ? (definiteConflict ? 'conflict_with_execution_record' : 'static_summary_over_mixed_media') : 'consistent_with_execution_record')
        : imageSummary && substantialVideos.length ? 'ambiguous_summary' : 'not_extracted',
        duration_check: 'receipt_window_only_not_a_claim_of_shot_duration' };
    });
    const pauses = facts.filter(s => s.label === 'breath');
    for (const pause of pauses) {
      const mentioned = observations.filter(r => overlaps(r.start_seconds, r.end_seconds, pause.start_seconds, pause.end_seconds)
        && /breath|气口|停顿|过渡静帧|短静帧/i.test(r.observed));
      if (!mentioned.length) issue('pause_not_separately_described', 'reporting_gap',
        '执行清单有breath，模型未单独描述；不等于没看见，也不等于空白/无意义画面。', [], [pause.scene_index]);
      const positive = observations.filter(r => ((r.path.startsWith('narrative.evidence') && unit.narrative.status === 'supported')
        || (r.path.startsWith('teaching.evidence') && unit.teaching.status === 'supported'))
        && r.channel === 'visual_organization'
        && Math.min(r.end_seconds, pause.end_seconds) - Math.max(r.start_seconds, pause.start_seconds) > .005 + Number.EPSILON * 16);
      if (positive.length && !mentioned.length) issue('pause_used_in_positive_evidence', 'needs_semantic_check',
        '正判证据范围含breath；不能据范围重叠认定模型把气口当成了教学画面，其作用尚未单独核实。',
        positive.map(r => r.path), [pause.scene_index]);
    }
    // Evidence ranges bracket transitions; a range start is NOT an asserted cut time.
    const cutChecks = group.cut_events.map(cut => ({ ...cut,
      matching_observation_paths: observations.filter(r => r.start_seconds <= cut.at_seconds + .005
        && r.end_seconds >= cut.at_seconds - .005).map(r => r.path),
      timestamp_check: 'range_context_only_exact_cut_not_asserted',
    }));
    return { unit_id: unit.unit_id, status: issues.length ? 'review_required' : 'no_detected_conflict',
      model_verdict_preserved: { relation: unit.relation, narrative: unit.narrative, teaching: unit.teaching },
      actual_segments: facts, cut_checks: cutChecks,
      scheduled_audio_gaps: structural.audio_gaps.filter(g => overlaps(start, end, g.start_seconds, g.end_seconds)),
      observation_checks: checks, issues };
  });
  return { scope: 'offline_preview_observation_timeline_check', version: 1,
    status: units.some(u => u.issues.length) || validation.issues.length ? 'review_required' : 'no_detected_conflict',
    existing_review_issues: validation.issues, units, full_film_accepted: false, new_model_calls: 0,
    limits: ['执行清单不是成片像素核验；源时间与成片时间分开列出。',
      '正则只定位明确中文静态/两张/清洗措辞；未解析内容不能算描述准确或语义通过。',
      '观察起止是证据区间，不自动当作精确切点或镜头时长；5ms仅用于两位小数边界取整。',
      '音轨安排不等于实际发声；breath有实物画面，不自动判无内容。',
      '不判断突兀、教学是否讲透或删除后更顺；不修改原始回执或制作批准。'] };
}
