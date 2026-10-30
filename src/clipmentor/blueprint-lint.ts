/** Advisory, deterministic author checks. No IO, provider, gate or approval dependency. */
import corpus from './fixtures/blueprint-self-check-cases.json';

type Row = Record<string, unknown>;
type Range = [number, number];
export interface BlueprintFinding {
  rule_id: string; level: 'warn' | 'notice'; location: string; excerpt: string; message: string;
}
export interface SpeechSample {
  id: string; text: string; seconds: number; product: string; group_id: string;
}
export interface MarkdownCheck {
  text: string;
  references: Array<{ reference: string; exists: boolean; is_source?: boolean; matches_input?: boolean }>;
}
const obj = (v: unknown): Row => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown) => typeof v === 'string' ? v : '';
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const range = (v: unknown): Range | null => Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && Number.isFinite(x)) && v[0] >= 0 && v[1] > v[0] ? v as Range : null;
export const wordCount = (text: string) => (text.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? []).length;
const round = (v: number) => Math.round(v * 1e6) / 1e6;
const walk = (v: unknown, fn: (s: string, path: string) => void, path = '$'): void => {
  if (typeof v === 'string') fn(v, path);
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, fn, `${path}[${i}]`));
  else for (const [k, x] of Object.entries(obj(v))) walk(x, fn, `${path}.${k}`);
};

/** Pauses are included. Error is empirical seconds/word, not a confidence guarantee. */
export function calibrateSpeech(samples: SpeechSample[]) {
  const valid = samples.filter(s => wordCount(s.text) > 0 && Number.isFinite(s.seconds) && s.seconds > 0);
  const words = valid.reduce((n, s) => n + wordCount(s.text), 0);
  const seconds = valid.reduce((n, s) => n + s.seconds, 0);
  const rate = words && seconds ? words / seconds : null;
  const errors = valid.map(s => ({ id: s.id, product: s.product, group_id: s.group_id, words: wordCount(s.text),
    measured_seconds: s.seconds, estimated_seconds: wordCount(s.text) / rate!,
    error_seconds: wordCount(s.text) / rate! - s.seconds,
    // Hold this file out, rather than presenting training residuals as validation.
    leave_one_out_error_seconds: valid.length > 1 ? wordCount(s.text) / ((words - wordCount(s.text)) / (seconds - s.seconds)) - s.seconds : null }));
  const bounds = errors.map(e => Math.abs(e.error_seconds) / e.words);
  const lowerErrors = errors.map(e => Math.max(0, e.error_seconds) / e.words);
  const groupErrors = [...new Set(valid.map(s => `${s.product}/${s.group_id}`))].map(group => {
    const rows = errors.filter(s => `${s.product}/${s.group_id}` === group);
    return { group, measured_seconds: round(rows.reduce((n, s) => n + s.measured_seconds, 0)),
      estimated_seconds: round(rows.reduce((n, s) => n + s.estimated_seconds, 0)), error_seconds: round(rows.reduce((n, s) => n + s.error_seconds, 0)) };
  });
  return { sample_count: valid.length, words_per_second: rate, empirical_error_seconds_per_word: bounds.length ? Math.max(...bounds) : null,
    empirical_lower_error_seconds_per_word: lowerErrors.length ? Math.max(...lowerErrors) : null,
    samples: errors, groups: groupErrors, note: 'Existing normal-speed file durations, including pauses. Empirical range only; not measured speech or evidence of teaching fit.' };
}

interface Line { id: string; text: string; zh: string; raw: Row; path: string }
interface Group { id: string; line_ids: string[]; capacity: number | null; path: string }
interface Use { asset: string; range: Range; location: string; mode: string }
function readBlueprint(value: unknown) {
  const root = obj(value), analysis = obj(root.clipMentorAnalysis), source = obj(analysis.source);
  const lines: Line[] = [], groups: Group[] = [], uses: Use[] = [];
  const issues: Array<{ path: string; message: string }> = [];
  const priorities = new Map<string, number>(), phasePictures = new Map<string, Row[]>();
  const deliveryIds = new Set<string>();
  const addLine = (v: unknown, path: string, priority = 1) => {
    const row = obj(v), id = str(row.id) || str(row.line_id) || path;
    if (!str(row.narration_ms)) return;
    const next = { id, text: str(row.narration_ms), zh: str(row.zh) || str(row.meaning_zh), raw: row, path };
    const index = lines.findIndex(l => l.id === id);
    if (index >= 0) {
      const old = lines[index];
      if (old.text !== next.text || old.zh !== next.zh || JSON.stringify(old.raw.labels ?? []) !== JSON.stringify(next.raw.labels ?? [])) {
        issues.push({ path, message: `Line ${id} conflict between ${old.path} and ${path}; current registered candidate takes precedence, copies require reconciliation.` });
      }
      if (priority > (priorities.get(id) ?? 0)) { lines[index] = next; priorities.set(id, priority); }
    } else { lines.push(next); priorities.set(id, priority); }
  };
  const narrations = Array.isArray(root.narration_and_captions) ? root.narration_and_captions : obj(root.narration_and_captions).lines;
  arr(narrations).forEach((v, i) => addLine(v, `$.narration_and_captions[${i}]`));
  const delivery = obj(root.delivery_sections);
  let opening = obj(delivery.opening), ends = obj(delivery.creator_endings);
  const addDeliveryLine = (v: unknown, path: string, priority = 1) => {
    const l = obj(v); addLine(l, path, priority);
    const id = str(l.id) || str(l.line_id); if (id) deliveryIds.add(id);
  };
  addDeliveryLine(opening, '$.delivery_sections.opening');
  Object.entries(ends).forEach(([k, v]) => addDeliveryLine(v, `$.delivery_sections.creator_endings.${k}`));
  const fps = num(obj(root.estimated_picture_timeline).fps) ?? num(source.fps);
  const addUse = (r: unknown, path: string, mode: string, asset?: unknown) => {
    const selected = range(r);
    // Unknown identity must not merge unrelated assets merely because coordinates match.
    if (selected) uses.push({ asset: str(asset) || str(source.asset_id) || `unknown:${path}`, range: selected, location: path, mode });
  };
  const phasedUnits = new Set<string>(), registeredSections: Array<{ row: Row; path: string }> = [];
  arr(analysis.blueprint).forEach((v, i) => {
    const u = obj(v), internal = obj(u.internal_review);
    const candidateId = str(internal.current_script_candidate), planId = str(internal.current_picture_plan);
    const candidate = obj(internal[candidateId]), plan = obj(internal[planId]);
    if (candidateId && !Array.isArray(candidate.lines)) issues.push({ path: `$.clipMentorAnalysis.blueprint[${i}]`, message: 'Current candidate pointer unreadable; estimates are incomplete.' });
    arr(candidate.lines).forEach((l, j) => addLine(l, `$.clipMentorAnalysis.blueprint[${i}].current_candidate.lines[${j}]`, 2));
    arr(plan.delivery_sections).forEach((section, j) => registeredSections.push({ row: obj(section), path: `$.clipMentorAnalysis.blueprint[${i}].current_picture_plan.delivery_sections[${j}]` }));
    let current: Group | undefined;
    const operational = Array.isArray(plan.phases) ? plan : obj(obj(plan.execution_plan).content);
    arr(operational.phases).forEach((p, j) => {
      const phase = obj(p), path = `$.clipMentorAnalysis.blueprint[${i}].current_picture_plan.phases[${j}]`, mode = str(phase.mode);
      if (mode !== 'original' && mode !== 'explanation') return;
      phasedUnits.add(str(u.unit_id));
      if (mode === 'original') {
        if (!current || current.line_ids.length) {
          current = { id: `${str(u.unit_id) || i}/group-${groups.length + 1}`, line_ids: [], capacity: 0, path }; groups.push(current);
        }
      } else {
        if (!current) { current = { id: str(u.unit_id) || path, line_ids: [], capacity: 0, path }; groups.push(current); }
        const ids = [...new Set([str(phase.line_id), ...arr(phase.line_ids).map(str)].filter(Boolean))];
        current.line_ids.push(...ids.filter(id => !current!.line_ids.includes(id)));
        for (const id of ids) phasePictures.set(id, [...phasePictures.get(id) ?? [], phase]);
        const r = range(phase.source_range_seconds);
        const declared = num(phase.output_duration_seconds) ?? num(phase.duration_seconds)
          ?? (num(phase.duration_frames) !== null && fps && fps > 0 ? num(phase.duration_frames)! / fps : null);
        const duration = declared !== null ? (declared >= 0 ? declared : null) : (r ? r[1] - r[0] : null);
        if (current.capacity !== null) current.capacity = duration === null ? null : current.capacity + duration;
      }
      addUse(phase.source_range_seconds, path, mode, phase.source_asset_id);
    });
  });
  arr(root.delivery_sections ?? analysis.delivery_sections).forEach((v, i) => registeredSections.push({ row: obj(v), path: `$.delivery_sections[${i}]` }));
  if (registeredSections.length) {
    // Production stores delivery sections on the current picture plan, not the
    // candidate's convenience object. Preserve each section's explicit role.
    const registeredEnds: Row = {};
    for (const { row: section, path } of registeredSections) {
      addDeliveryLine(section.line, `${path}.line`, 2);
      const line = obj(section.line), id = str(line.line_id) || str(line.id);
      phasePictures.set(id, [...phasePictures.get(id) ?? [], { picture: section.picture }]);
      if (section.kind === 'performance_opening') opening = line;
      else if (section.kind === 'creator_invitation') registeredEnds[str(section.section_id) || path] = line;
    }
    if (Object.keys(registeredEnds).length) ends = registeredEnds;
  }
  const rows = arr(obj(root.estimated_picture_timeline).rows);
  rows.forEach((v, i) => {
    const r = obj(v); if (phasedUnits.has(str(r.unit_id))) return;
    const path = `$.estimated_picture_timeline.rows[${i}]`, ids = arr(r.line_ids).map(str);
    const seconds = range(r.source_range_seconds) ?? range(r.original_source_seconds)
      ?? (range(r.source_frames) && fps && fps > 0 ? range(r.source_frames)!.map(n => n / fps) as Range : null);
    const modes = arr(r.mode_order).map(str);
    if (modes.length) {
      for (const mode of modes) addUse(seconds, path, mode, r.source_asset_id);
      groups.push({ id: str(r.unit_id) || str(r.row_id) || path, line_ids: ids, capacity: seconds ? seconds[1] - seconds[0] : null, path });
    } else {
      const mode = str(r.kind); addUse(seconds, path, mode, r.source_asset_id);
      if (ids.length && mode !== 'original') {
        const id = str(r.group_id) || str(r.unit_id) || path, current = groups.find(g => g.id === id);
        const duration = num(r.duration_seconds_reference) ?? (seconds ? seconds[1] - seconds[0] : null);
        if (current) { current.line_ids.push(...ids.filter(x => !current.line_ids.includes(x))); current.capacity = current.capacity !== null && duration !== null ? current.capacity + duration : null; }
        else groups.push({ id, line_ids: ids, capacity: duration, path });
      }
    }
  });
  return { root, analysis, lines, groups, uses, phasePictures, ends, opening, deliveryIds, issues };
}

const malayNumbers: Record<string, number> = { kosong: 0, satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, lapan: 8, sembilan: 9, sepuluh: 10, sebelas: 11, seratus: 100, seribu: 1000 };
/** Literal quantities only. Matching them cannot establish equal promise scope. */
function quantityKeys(text: string): string[] {
  // Keep punctuation boundaries. A list such as "dua, tiga" is two quantities,
  // not a malformed Malay phrase that can be added into five.
  const tokens = text.toLowerCase().match(/\d+(?:[.,]\d+)*|[a-z]+|[^\s]/gu) ?? [];
  const value = (t: string) => Object.hasOwn(malayNumbers, t) ? malayNumbers[t] : null;
  const belowHundred = (i: number): { n: number; end: number } | null => {
    const n = value(tokens[i]); if (n === null || n > 11) return null;
    if (n < 10 && tokens[i + 1] === 'belas') return { n: n + 10, end: i + 2 };
    if (n < 10 && tokens[i + 1] === 'puluh') {
      const ones = value(tokens[i + 2]);
      return { n: n * 10 + (ones !== null && ones < 10 ? ones : 0), end: i + (ones !== null && ones < 10 ? 3 : 2) };
    }
    return { n, end: i + 1 };
  };
  const chunk = (i: number): { n: number; end: number } | null => {
    const token = tokens[i] ?? '';
    if (/^\d/.test(token)) {
      const raw = /^\d+,\d{1,2}$/.test(token) ? token.replace(',', '.') : token.replace(/,(?=\d{3}(?:\D|$))/g, '');
      const n = Number(raw); return Number.isFinite(n) ? { n, end: i + 1 } : null;
    }
    const n = value(token); if (n === null) return null;
    if (n === 100 || n < 10 && tokens[i + 1] === 'ratus') {
      const end = i + (n === 100 ? 1 : 2), tail = belowHundred(end);
      return { n: (n === 100 ? 100 : n * 100) + (tail?.n ?? 0), end: tail?.end ?? end };
    }
    if (n === 1000) {
      const tail = value(tokens[i + 1]) === 1000 ? null : chunk(i + 1);
      return tail && tail.n < 1000 ? { n: n + tail.n, end: tail.end } : { n, end: i + 1 };
    }
    return belowHundred(i);
  };
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const first = chunk(i); if (!first) continue;
    let n = first.n, j = first.end;
    if (tokens[j] === 'perpuluhan') {
      const decimalStart = ++j; let fraction = '';
      while (value(tokens[j]) !== null && value(tokens[j])! < 10) fraction += value(tokens[j++]);
      if (j > decimalStart) n += Number(`0.${fraction}`);
    }
    let total = 0, lastScale = Infinity;
    while (['juta', 'ribu', 'k'].includes(tokens[j])) {
      const scale = tokens[j] === 'juta' ? 1e6 : 1000;
      if (scale >= lastScale) break;
      total += n * scale; lastScale = scale; j++;
      const tail = chunk(j);
      if (!tail) { n = 0; break; }
      n = tail.n; j = tail.end;
    }
    n += total;
    const currencies: Record<string, string> = { rm: 'RM', myr: 'RM', ringgit: 'RM', usd: 'USD', '$': 'USD', '€': 'EUR', '£': 'GBP' };
    const unit = currencies[tokens[i - 1]] ?? currencies[tokens[j]] ?? (tokens[j] === '%' || tokens[j] === 'peratus' ? '%' : '');
    result.push(`${round(n)}${unit}`); i = Math.max(i, j - 1);
  }
  return result;
}

/** Experimental morphology is measured separately; deliberately not enabled by lint. */
export function repeatedRootCandidates(text: string) {
  const result: Array<{ sentence: string; root: string; words: string[] }> = [];
  for (const sentence of text.split(/[.!?]+/u)) {
    const roots = new Map<string, string[]>();
    for (const word of sentence.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? []) {
      let root = word.replace(/(kan|nya|an|i)$/u, '');
      const prefix = root.match(/^(meng|meny|men|mem|me|ber|di|ter)/u)?.[0];
      if (prefix && root.length - prefix.length >= 3) {
        root = root.slice(prefix.length);
        if (prefix === 'meny') root = `s${root}`;
        else if (prefix === 'men' && /^[aiueo]/.test(root)) root = `t${root}`;
      }
      if (root.length < 4) continue;
      roots.set(root, [...roots.get(root) ?? [], word]);
    }
    for (const [root, words] of roots) if (words.length > 1) result.push({ sentence: sentence.trim(), root, words });
  }
  return result;
}

export function lintBlueprint(input: unknown, options: { markdown?: MarkdownCheck; samples?: SpeechSample[] } = {}) {
  const findings: BlueprintFinding[] = [], data = readBlueprint(input);
  const add = (rule_id: string, level: BlueprintFinding['level'], location: string, excerpt: string, message: string) => findings.push({ rule_id, level, location, excerpt, message });
  for (const issue of data.issues) add('INPUT', 'notice', issue.path, '', issue.message);
  if (!input || !data.lines.length && !data.groups.length) add('INPUT', 'notice', '$', '', 'No readable candidate object; no approval or complete-check claim.');
  walk(input, (s, path) => {
    // Ellipses are quoted omissions, not doubled sentence terminators.
    if (/(。{2,}|，{2,}|(?<!\.)\.{2}(?!\.))/u.test(s) || s !== s.trim()) add('B01', 'warn', path, s, 'Repeated punctuation or edge whitespace; inspect the original, do not auto-rewrite quotations.');
  });
  const names: Array<{ location: string; text: string }> = [];
  if (str(data.root.title)) names.push({ location: '$.title', text: str(data.root.title) });
  for (const [product, path] of [[obj(data.root.product), '$.product'], [obj(data.analysis.product), '$.clipMentorAnalysis.product']] as const) {
    for (const key of ['name', 'brand', 'brand_name', 'product_name']) if (str(product[key])) names.push({ location: `${path}.${key}`, text: str(product[key]) });
  }
  const declaredNameParts = names.flatMap(n => n.text.split('|').map(s => s.trim())).filter(Boolean);
  if (new Set(declaredNameParts.map(n => n.toLowerCase())).size > 1) add('B03', 'notice', '$', JSON.stringify(names), 'Different working/product names found; verify the displayed name. This is a naming inventory, not proof that aliases are inconsistent.');
  const visibleTextInventory: Array<{ line_id: string; text: string }> = [];
  for (const l of data.lines) {
    if (/[0-9%$€£]|\b(?:RM|MYR|USD)\b/u.test(l.text)) add('B02', 'warn', l.id, l.text, 'Confirm spoken number/currency/percentage pronunciation before TTS; text is unchanged.');
    const visible: string[] = [];
    for (const label of arr(l.raw.labels)) if (typeof label === 'string') visible.push(label); else if (str(obj(label).text)) visible.push(str(obj(label).text));
    for (const key of ['screen_text', 'on_screen_text']) walk(l.raw[key], s => visible.push(s));
    // Only declared visible strings, never geometry, source times or author notes.
    const screenFields = new Set(['text', 'screen_text', 'on_screen_text', 'visible_text', 'labels', 'short_labels']);
    const pictureContainers = new Set(['picture', 'overlay', 'overlays', 'elements', 'children', 'text_layers', 'composition']);
    const collectPicture = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(collectPicture); return; }
      for (const [key, value] of Object.entries(obj(v))) {
        if (screenFields.has(key)) {
          if (typeof value === 'string') visible.push(value);
          else if (Array.isArray(value)) value.forEach(part => typeof part === 'string' ? visible.push(part) : collectPicture(part));
          else collectPicture(value);
        } else if (pictureContainers.has(key)) collectPicture(value);
      }
    };
    collectPicture(l.raw.picture);
    for (const phase of data.phasePictures.get(l.id) ?? []) collectPicture(phase);
    for (const section of arr(data.root.delivery_sections ?? data.analysis.delivery_sections)) {
      const row = obj(section);
      if (str(obj(row.line).id) === l.id || str(obj(row.line).line_id) === l.id) collectPicture(row.picture);
    }
    visibleTextInventory.push(...[...new Set(visible)].map(text => ({ line_id: l.id, text })));
    const spoken = new Set(quantityKeys(l.text));
    for (const text of visible) {
      const extra = quantityKeys(text).filter(k => !spoken.has(k));
      if (extra.length) add('B04', 'warn', l.id, text, `Visible literal quantities absent from this narration: ${extra.join(', ')}. Check promise scope; silence alone is not a false claim.`);
    }
  }
  const calibration = calibrateSpeech(options.samples ?? corpus.calibration);
  const estimate = (text: string) => calibration.words_per_second ? wordCount(text) / calibration.words_per_second : null;
  const lineEstimates = data.lines.map(l => ({ line_id: l.id, words: wordCount(l.text), estimated_seconds: estimate(l.text) }));
  const groups = data.groups.map(g => {
    const selected = g.line_ids.map(id => data.lines.find(l => l.id === id));
    const complete = selected.length > 0 && selected.every(Boolean);
    const words = selected.reduce((n, l) => n + (l ? wordCount(l.text) : 0), 0);
    const seconds = complete && calibration.words_per_second ? words / calibration.words_per_second : null;
    const error = calibration.empirical_lower_error_seconds_per_word !== null ? words * calibration.empirical_lower_error_seconds_per_word : null;
    const lower = seconds !== null && error !== null ? Math.max(0, seconds - error) : null;
    if (lower !== null && g.capacity !== null && lower > g.capacity) add('B05', 'warn', g.id, selected.map(l => l?.text ?? '').join(' '), `Group estimate ${round(seconds!)}s, empirical lower estimate ${round(lower)}s > planned ${round(g.capacity)}s. Estimate only; use measured audio and teaching objects to decide.`);
    else if (!complete || g.capacity === null) add('B05', 'notice', g.id, g.line_ids.join(', '), 'Group estimate incomplete: missing line binding or explicit picture duration. Do not infer short holds from prose.');
    return { group_id: g.id, line_ids: g.line_ids, words, estimated_seconds: seconds, empirical_error_seconds: error, empirical_lower_seconds: lower, picture_seconds: g.capacity, complete };
  });
  for (const l of lineEstimates) add('B05', 'notice', l.line_id, data.lines.find(x => x.id === l.line_id)!.text, `Reference only: ${l.words} words, ${l.estimated_seconds === null ? 'uncalibrated' : round(l.estimated_seconds) + 's estimated'}. Never reject a single line by this value.`);
  const original = data.uses.filter(u => u.mode === 'original').reduce((n, u) => n + u.range[1] - u.range[0], 0);
  const boundLineIds = new Set(data.groups.flatMap(g => g.line_ids));
  const bodyLines = data.lines.filter(l => !data.deliveryIds.has(l.id) && (!data.groups.length || boundLineIds.has(l.id)));
  const body = bodyLines.reduce((n, l) => n + (estimate(l.text) ?? 0), 0), opening = estimate(str(data.opening.narration_ms)) ?? 0;
  const variants = Object.keys(data.ends).length ? Object.entries(data.ends).map(([variant, v]) => ({ variant, ending: estimate(str(obj(v).narration_ms)) })) : [{ variant: 'current', ending: 0 }];
  const durations = variants.map(v => ({ variant: v.variant, original_seconds: original, explanation_seconds: body, opening_seconds: opening, ending_seconds: v.ending,
    estimated_total_seconds: calibration.words_per_second && data.groups.length && data.uses.some(u => u.mode === 'original') && groups.every(g => g.complete) ? round(original + body + opening + (v.ending ?? 0)) : null }));
  for (const d of durations) add('B06', 'notice', d.variant, JSON.stringify(d), 'Estimated full length, not a length limit or measured preview. No automatic trimming.');
  const reuse: Array<{ asset: string; range: Range; count: number; locations: string[] }> = [];
  for (const asset of new Set(data.uses.map(u => u.asset))) {
    const uses = data.uses.filter(u => u.asset === asset), points = [...new Set(uses.flatMap(u => u.range))].sort((a, b) => a - b);
    for (let i = 1; i < points.length; i++) {
      const active = uses.filter(u => u.range[0] <= points[i - 1] && u.range[1] >= points[i]);
      if (active.length < 3) continue;
      const locations = active.map(u => u.location), previous = reuse.at(-1);
      if (previous?.asset === asset && previous.range[1] === points[i - 1] && JSON.stringify(previous.locations) === JSON.stringify(locations)) previous.range[1] = points[i];
      else reuse.push({ asset, range: [points[i - 1], points[i]], count: active.length, locations });
    }
  }
  for (const r of reuse) add('B07', 'notice', r.locations.join(', '), JSON.stringify(r), 'Same source coordinates are used at least three times. Reuse can teach a new relation; this is not a redundancy verdict.');
  if (options.markdown) {
    for (const l of data.lines) for (const [key, text] of [['narration_ms', l.text], ['zh', l.zh]]) {
      if (text && !options.markdown.text.includes(text)) add('B09', 'warn', `${l.id}.${key}`, text, 'Exact saved text absent from Markdown; compare versions.');
    }
    for (const ref of options.markdown.references) {
      if (!ref.exists) add('B09', 'warn', 'markdown.reference', ref.reference, 'Referenced local JSON does not exist.');
      else if (ref.is_source && ref.matches_input === false) add('B09', 'warn', 'markdown.reference', ref.reference, 'Markdown machine source is not the checked JSON input.');
    }
  }
  return { advisory_only: true, scope: 'saved_blueprint_author_preparation_not_approval', findings,
    calibration, name_inventory: { declared: names, visible_text: visibleTextInventory, note: 'Declared names and visible text only; no semantic brand recognition or automatic alias correction.' }, line_estimates: lineEstimates, groups, durations, reuse,
    disabled_rules: [{ rule_id: 'B08', reason: 'Pilot on frozen accepted copy has more false-positive candidates than known hits; see regression statistics. No root-based lint is shipped.' }],
    limitations: ['Source-coordinate overlap cannot identify the same action in disjoint montage shots.', 'Written claims and word counts do not prove audible wording, visual clarity or teaching value.', 'No markdown comparison when --md is omitted.', 'Picture descriptions and unstructured image pixels are not decoded for text or duration.'] };
}
