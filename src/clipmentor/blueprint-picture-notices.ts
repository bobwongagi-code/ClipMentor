/** Shared advisory questions, not image understanding or executable parameters. */
type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown) => typeof v === 'string' ? v : '';
const window = (v: unknown): [number, number] | null => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n)) && v[0] >= 0 && v[1] >= v[0] ? [v[0], v[1]] : null;

/** Resolve the existing operational/legacy phase fields identically for both callers. */
export function currentPicturePhases(plan: Row, timeline: unknown, unitId: unknown, fps: number, durationSeconds?: number) {
  const direct = Object.hasOwn(plan, 'phases');
  const operational = direct ? plan : obj(obj(plan.execution_plan).content);
  const prefix = direct ? '.phases' : '.execution_plan.content.phases';
  const raw = arr(operational.phases), issues: Array<{ path: string; message: string }> = [];
  let phases = raw.map(obj), locations = phases.map((_, i) => `${prefix}[${i}]`);
  let pictureLocations = locations.map(path => path + '.picture'), legacyMissing = false;
  const ids = (p: Row) => [...new Set([text(p.line_id), ...arr(p.line_ids).map(text)].filter(Boolean))];
  if (!Array.isArray(operational.phases) || !raw.length) issues.push({ path: prefix, message: 'Current picture phases missing, empty or not an array.' });
  for (const [i, p] of raw.entries()) if (p === null || typeof p !== 'object' || Array.isArray(p)) issues.push({ path: `${prefix}[${i}]`, message: 'Picture phase must be an object.' });
  // Only explicit, meaningful old explanation records may use old timeline rows.
  // Empty/malformed modern content is never evidence of a legacy format.
  const legacy = phases.length > 0 && phases.every(p => p.mode === undefined && ids(p).length > 0);
  if (legacy && !issues.length) {
    const allRows = arr(obj(timeline).rows).map(obj), rows = allRows.filter(r => r.unit_id === unitId), priorPhases = phases;
    locations = rows.map(r => `$.estimated_picture_timeline.rows[${allRows.indexOf(r)}]`);
    legacyMissing = rows.length === 0;
    if (legacyMissing) issues.push({ path: prefix, message: 'Declared legacy phases have no corresponding timeline rows.' });
    pictureLocations = rows.map(r => {
      if (text(r.picture)) return `$.estimated_picture_timeline.rows[${allRows.indexOf(r)}].picture`;
      const i = priorPhases.findIndex(p => ids(p).some(id => arr(r.line_ids).includes(id)));
      return i < 0 ? '' : `${prefix}[${i}].picture`;
    });
    phases = rows.map(r => {
      const range = window(r.source_range_seconds), frames = window(r.source_frames);
      const prior = priorPhases.find(p => ids(p).some(id => arr(r.line_ids).includes(id)));
      return { ...r, mode: r.kind, source_range_seconds: range ?? (frames && Number.isFinite(fps) && fps > 0 ? frames.map(n => n / fps) : undefined), picture: text(r.picture) || text(prior?.picture) };
    });
    const declared = new Set(priorPhases.flatMap(ids));
    const mapped = new Set(phases.filter(p => p.mode === 'explanation').flatMap(ids));
    if ([...declared].some(id => !mapped.has(id)) || [...mapped].some(id => !declared.has(id))) issues.push({ path: prefix, message: 'Legacy timeline explanation IDs do not match the declared picture phases.' });
  }
  for (const [i, phase] of phases.entries()) {
    const stage = phase.mode === undefined && text(phase.line_id) ? 'explanation' : phase.mode;
    if (stage !== 'original' && stage !== 'explanation') issues.push({ path: locations[i] + '.mode', message: 'Unknown or missing picture stage.' });
    const range = window(phase.source_range_seconds ?? phase.source_seconds);
    if (!range || typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && (range[0] >= durationSeconds || range[1] > durationSeconds)) issues.push({ path: locations[i], message: 'Picture source range is missing, invalid or beyond the source.' });
    if (stage === 'explanation' && !ids(phase).length) issues.push({ path: locations[i], message: 'Explanation phase has no line IDs.' });
  }
  return { operational, phases, legacy, legacyMissing, locations, pictureLocations, issues };
}
export interface PictureNoticeRow {
  key: string; unit_id: string; stage: string; line_ids: string[];
  range: [number, number] | null; picture: string; location: string; picture_location?: string;
}
export interface PictureNotice {
  rule_id: 'B10' | 'B11'; level: 'notice'; location: string; excerpt: string; message: string;
  row_keys: string[]; locations: string[];
}
export function blueprintPictureNotices(rows: PictureNoticeRow[]): PictureNotice[] {
  const explanations = rows.filter(r => r.stage === 'explanation');
  const ids = [...new Set(explanations.flatMap(r => r.line_ids))];
  const label = (r: PictureNoticeRow) => r.line_ids.map(id => `第${ids.indexOf(id) + 1}句`).join('、');
  const n = (v: number) => Number(v.toFixed(1)).toString();
  const out: PictureNotice[] = [];
  for (const r of explanations) {
    // This is deliberately only a keyword question. Never parse prose frame
    // numbers into extraction/editing coordinates or claim a proven conflict.
    if (r.range && r.range[0] !== r.range[1] && /(?:源帧|参照帧|静帧|代表帧|source\s*frame|freeze\s*frame)/iu.test(r.picture)) {
      const location = r.picture_location ?? r.location + '.picture';
      out.push({ rule_id: 'B10', level: 'notice', location, locations: [location], excerpt: r.picture, row_keys: [r.key],
        message: `画面说明提到指定画面，但计划登记的是整段${n(r.range[0])}–${n(r.range[1])}秒。是要使用指定画面，还是播放这段动态？` });
    }
  }
  for (let i = 0; i < explanations.length; i++) for (let j = i + 1; j < explanations.length; j++) {
    const a = explanations[i], b = explanations[j];
    // Original playback versus revisit is intentional reuse, not copied tasks.
    if (!a.picture.trim() || a.picture !== b.picture || a.line_ids.some(id => b.line_ids.includes(id))) continue;
    const locations = [a.picture_location ?? a.location + '.picture', b.picture_location ?? b.location + '.picture'];
    out.push({ rule_id: 'B11', level: 'notice', location: locations[0], locations, excerpt: a.picture, row_keys: [a.key, b.key],
      message: `${label(a)}与${label(b)}的画面说明相同，是否需要分别写清各自画什么？` });
  }
  return out;
}
export function pictureNoticeRows(data: { root: Row; analysis: Row; selectedPlans: Array<{ unit: Row; plan: Row; plan_id: string; path: string; resolved?: ReturnType<typeof currentPicturePhases> }> }): PictureNoticeRow[] {
  const fps = Number(obj(data.analysis.source).fps), rows: PictureNoticeRow[] = [];
  for (const selected of data.selectedPlans) {
    const { operational, phases, locations, pictureLocations } = selected.resolved ?? currentPicturePhases(selected.plan, data.root.estimated_picture_timeline, selected.unit.unit_id, fps);
    const base = `${selected.path}.internal_review[${JSON.stringify(selected.plan_id)}]`;
    const absolute = (path: string) => path.startsWith('$') ? path : base + path;
    for (const [index, phase] of phases.entries()) {
      const stage = phase.mode === undefined && text(phase.line_id) ? 'explanation' : text(phase.mode);
      if (stage !== 'original' && stage !== 'explanation') continue;
      rows.push({ key: `${text(selected.unit.unit_id)}/${index}`, unit_id: text(selected.unit.unit_id), stage,
        line_ids: [...new Set([text(phase.line_id), ...arr(phase.line_ids).map(text)].filter(Boolean))],
        range: window(phase.source_range_seconds ?? phase.source_seconds), picture: text(phase.picture) || text(obj(operational.composition).detail),
        location: absolute(locations[index]),
        picture_location: text(phase.picture) ? absolute(pictureLocations[index]) : absolute(`${Array.isArray(selected.plan.phases) ? '' : '.execution_plan.content'}.composition.detail`) });
    }
  }
  return rows;
}

/** Resolve only concrete saved JSON paths. No evaluation, IO or inherited fields. */
function pictureQuoteAt(input: unknown, path: string): unknown {
  if (!path.startsWith('$')) throw Error('not a saved JSON path');
  let rest = path.slice(1), value: unknown = input;
  while (rest) {
    const match = /^(?:\.([A-Za-z_$][\w$]*)|\[(\d+|"(?:[^"\\]|\\.)*")\])/u.exec(rest);
    if (!match) throw Error('not a concrete field');
    const key = match[1] ?? JSON.parse(match[2]);
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw Error('quoted field missing');
    value = (value as Row)[key]; rest = rest.slice(match[0].length);
  }
  return value;
}
/** Runtime integrity check for the existing lint/report entry, never an approval. */
export function verifyPictureNoticeSources(input: unknown, notices: PictureNotice[]) {
  const verified: PictureNotice[] = [], issues: Array<{ path: string; message: string }> = [];
  for (const notice of notices) {
    let valid = true;
    if (notice.locations.length < (notice.rule_id === 'B11' ? 2 : 1) || !notice.locations.includes(notice.location)) {
      valid = false; issues.push({ path: notice.location, message: `${notice.rule_id}: incomplete picture quote locations; diagnostic not published.` });
    }
    for (const path of notice.locations) {
      try {
        if (pictureQuoteAt(input, path) !== notice.excerpt) throw Error('quoted text differs');
      } catch {
        valid = false; issues.push({ path, message: `${notice.rule_id}: picture quote cannot be read back verbatim from this input; diagnostic not published.` });
      }
    }
    if (valid) verified.push(notice);
  }
  return { notices: verified, issues };
}
