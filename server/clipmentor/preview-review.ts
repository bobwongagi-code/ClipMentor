import { createHash } from 'node:crypto';
import { echoesMediaSecret, videoRequestDigest, videoInput, VIDEO_URL_MAX_BYTES, VIDEO_REQUEST_MAX_BYTES, type VideoInput } from './video-input';

// Conservative Rootify route bounds. Larger official API limits do not prove gateway support.
export const EXTERNAL_VIDEO_URL_MAX_BYTES = VIDEO_URL_MAX_BYTES;
export const INLINE_REQUEST_MAX_BYTES = VIDEO_REQUEST_MAX_BYTES;
export const PREVIEW_REVIEW_MODEL = 'gemini-3.8-flash';
export const PREVIEW_REVIEW_ENDPOINT = `https://rootifyaiapi.rootifyglobal.com/v1beta/models/${PREVIEW_REVIEW_MODEL}:generateContent`;
export const PREVIEW_REVIEW_TIMEOUT_MS = 600_000;
// Five focus points plus unit receipts exceeded 8192 shared thought/output tokens in a real run.
export const PREVIEW_REVIEW_MAX_OUTPUT_TOKENS = 16_384;
export const PREVIEW_REVIEW_VERSION = 'teaching-evidence-v1';

export interface PreviewFocus {
  point_id: string;
  teaching_goal_zh: string;
  product_relevance: string;
}
export interface PreviewReferenceText {
  channel: 'narration' | 'annotation';
  start_seconds: number;
  end_seconds: number;
  text: string;
}
export interface PreviewReviewInput {
  duration_seconds: number;
  points: PreviewFocus[];
  units: Array<{ unit_id: string; point_ids: string[]; output_range_seconds?: [number, number] }>;
  reference_text: PreviewReferenceText[];
  visual_criteria?: Array<{point_id:string;quote:string;question:string;pictureStage?:string;fileName:string;seconds:number;base64:string}>;
}
export interface ReviewReceipt {
  start_seconds: number;
  end_seconds: number;
  channel: 'original' | 'narration' | 'annotation' | 'visual_organization';
  observed: string;
  quote?: string;
}
type FindingState = 'supported' | 'not_supported' | 'insufficient_evidence';
interface Finding {
  status: FindingState;
  reasoning: string;
  evidence: ReviewReceipt[];
}
export interface PreviewTeachingJudgment {
  coverage: Array<{ point_id: string; depiction: ReviewReceipt[]; teaching: Finding }>;
  continuity: Array<{
    unit_id: string;
    point_ids: string[];
    previous: ReviewReceipt[];
    current: ReviewReceipt[];
    relation: 'continuation' | 'recap' | 'new_information';
    narrative: Finding;
    teaching: Finding;
  }>;
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const normalize = (v: string) => v.normalize('NFKC').toLowerCase().replace(/[\p{P}\s]+/gu, '');
const range = (v: Record<string, unknown>, duration: number, observation=false) => typeof v.start_seconds === 'number'
  && typeof v.end_seconds === 'number' && Number.isFinite(v.start_seconds) && Number.isFinite(v.end_seconds)
  && v.start_seconds >= 0 && v.start_seconds < duration && v.end_seconds > v.start_seconds
  && v.end_seconds <= (observation ? Math.max(duration,Number(duration.toFixed(2))) : duration);

export function validatePreviewReviewInput(value: unknown): PreviewReviewInput {
  if (!object(value) || typeof value.duration_seconds !== 'number' || !Number.isFinite(value.duration_seconds)
    || value.duration_seconds <= 0 || !Array.isArray(value.points) || !value.points.length
    || !Array.isArray(value.units) || !value.units.length || !Array.isArray(value.reference_text)) throw new Error('Invalid preview review input');
  const ids = new Set<string>();
  for (const point of value.points) {
    if (!object(point) || !text(point.point_id) || ids.has(point.point_id)
      || !text(point.teaching_goal_zh) || !text(point.product_relevance)) throw new Error('Invalid or duplicate focus point');
    ids.add(point.point_id);
  }
  for (const reference of value.reference_text) {
    if (!object(reference) || !(typeof reference.channel === 'string' && ['narration', 'annotation'].includes(reference.channel))
      || !range(reference, value.duration_seconds) || !text(reference.text)) throw new Error('Invalid reference text');
  }
  const units = new Set<string>();
  for (const unit of value.units) {
    if (!object(unit) || !text(unit.unit_id) || units.has(unit.unit_id) || !Array.isArray(unit.point_ids)
      || !unit.point_ids.length || !unit.point_ids.every((id) => typeof id === 'string' && ids.has(id))) throw new Error('Invalid review unit');
    if (unit.output_range_seconds !== undefined && (!Array.isArray(unit.output_range_seconds) || unit.output_range_seconds.length !== 2
      || !range({ start_seconds: unit.output_range_seconds[0], end_seconds: unit.output_range_seconds[1] }, value.duration_seconds))) throw new Error('Invalid unit output range');
    units.add(unit.unit_id);
  }
  // Whitelist fields: author reasons, expected verdicts and prior reviews never enter the prompt.
  const visual=value.visual_criteria;
  if(visual!==undefined&&(!Array.isArray(visual)||!visual.length||visual.length>4||new Set(visual.map(v=>object(v)?v.point_id:null)).size!==visual.length
    ||!visual.every(v=>object(v)&&typeof v.point_id==='string'&&v.point_id.startsWith('delivery/criterion/')&&ids.has(v.point_id)
      &&(v.pictureStage===undefined||text(v.pictureStage)&&v.pictureStage.length<=80)&&text(v.quote)&&v.quote.length<=1000&&text(v.question)&&v.question.length<=300&&text(v.fileName)&&v.fileName.length<=240
      &&typeof v.seconds==='number'&&Number.isFinite(v.seconds)&&v.seconds>=0&&text(v.base64)&&v.base64.length<=1_500_000&&/^[A-Za-z0-9+/]+={0,2}$/.test(v.base64))))
    throw Error('Invalid preview visual criteria');
  return { duration_seconds: value.duration_seconds,
    points: value.points.map((p) => ({ point_id: p.point_id, teaching_goal_zh: p.teaching_goal_zh, product_relevance: p.product_relevance })),
    units: value.units.map((u) => ({ unit_id: u.unit_id, point_ids: [...u.point_ids], ...(u.output_range_seconds === undefined ? {} : { output_range_seconds: [...u.output_range_seconds] as [number, number] }) })),
    reference_text: value.reference_text.map((r) => ({ channel: r.channel, start_seconds: r.start_seconds,
      end_seconds: r.end_seconds, text: r.text })),
    ...(Array.isArray(visual)?{visual_criteria:visual.map(v=>({point_id:v.point_id,quote:v.quote,question:v.question,...(v.pictureStage===undefined?{}:{pictureStage:v.pictureStage}),fileName:v.fileName,seconds:v.seconds,base64:v.base64}))}:{}) };
}

export function assertExternalVideoUrlSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > EXTERNAL_VIDEO_URL_MAX_BYTES) {
    throw new Error('External video URL exceeds the documented 15MB limit; use bounded inline input or an explicitly supported file-upload route');
  }
}

function previewReviewShell(part: ReturnType<typeof videoInput>['part'], input: PreviewReviewInput) {
  const clean = validatePreviewReviewInput(input);
  const {visual_criteria:criteria,...material}=clean;
  const visualInstruction=criteria?.some(c=>c.pictureStage!==undefined)?'用实际导出视频指定pictureStage的画面回答问题；同一point的多个单元逐个核对，每段给定位在本单元窗口内的视觉证据，不能以一组代全部，缺该阶段填insufficient_evidence。参照图仅用于对比。':'用实际导出视频的本段画面回答每个问题，参照图仅用于对比。';
  const instruction = `你是独立视听复核员，面向创作者学习产品表达的教学预览。正常顺序看完视频，只按视频和下列学习目标评审，不改稿，不猜作者意图，不强行找问题。
分别判断动作是否出现、教学作用是否传达，以及叙事承接和教学承接。顺序可理解不等于为什么值得学已经传达；可以回顾，也可以由清晰的画面组织承担解释，不强制每点一句旁白或固定回看用语。原片有动作不自动完成教学解释。目标是表达方式，不是产品功效认证。
每个supported判断给实际预览时间及证据。口播/短标引用原句；画面组织说明具体对象、阶段和组合如何表达对应价值，不只写“清楚、自然、方便”。不要把目标清单里的意义冒充视频已经说出的意义。听不清留未知。reference_text是工程文字依据，不是逐词听审结果。narration或annotation证据必须独立填写quote字段，引用对应时间、对应channel的reference_text原句，不能只在observed中加引号。若没有可核的文字依据，用visual_organization描述实际可见对象和布局，不能把画面描述标作无quote的annotation。没有充分依据用insufficient_evidence，不用推测补全。允许不同项目有不同结论，不计算成片总分。
只返回JSON，结构如下。所有时间是本次预览从0开始的秒数。对于output_range_seconds起点为0的片头单元，previous填空数组，不能虚构前置画面；current及正向判断仍须给实际区间和证据。其他单元必须有前后画面证据。coverage恰好包含每个point_id一次；continuity恰好包含每个units里的unit_id一次，保留对应point_ids，不把所有单元泛称一组。
{"coverage":[{"point_id":"目标ID","depiction":[证据],"teaching":判断}],"continuity":[{"unit_id":"单元或衔接ID","point_ids":["相关目标ID"],"previous":[证据],"current":[证据],"relation":"continuation或recap或new_information","narrative":判断,"teaching":判断}]}
判断={"status":"supported或not_supported或insufficient_evidence","reasoning":"实际依据及限制","evidence":[证据]}
证据={"start_seconds":0,"end_seconds":1,"channel":"original或narration或annotation或visual_organization","observed":"实际观察","quote":"仅口播或文字时引用；视觉组织可不填"}
学习目标和工程文字：\n${JSON.stringify(material)}${clean.points.some(p=>p.point_id.startsWith('delivery/'))
 ?'\n以 delivery/ 开头的是交付验收。根据实际导出像素和口播判断所列要求，逐项给时间证据；teaching 字段在这里填交付效果，无需教学知识。coverage 的每项正向结论（包括 delivery/criterion/ 项）都必须在自己的teaching.evidence中给至少一条与本段相交的visual_organization证据；口播提问标准也要另附实际画面证据，不能只给narration或借用其他coverage行。片头可用本段和相邻画面核承接。'
 :''}${criteria?'\n用户原话、问题和参照另附。'+visualInstruction+'无法在实际导出中定位时填 insufficient_evidence。':''}`;
  const shell = { contents: [{ role: 'user', parts: [
    part, { text: instruction },
  ] }], generationConfig: { maxOutputTokens: PREVIEW_REVIEW_MAX_OUTPUT_TOKENS, temperature: 0, responseMimeType: 'application/json' } };
  for(const {base64,...criterion} of criteria??[])shell.contents[0].parts.push({text:JSON.stringify(criterion)},
    {inlineData:{mimeType:'image/jpeg',data:base64}} as typeof shell.contents[0]['parts'][number]);
  return {shell,clean,instruction};
}

/** Pure bounded preflight without reading/base64-encoding the whole file or minting an unverified URL. */
export function previewReviewIdentity(sha256:string, bytes:number, input:PreviewReviewInput) {
  if(!/^[a-f0-9]{64}$/.test(sha256)||!Number.isSafeInteger(bytes)||bytes<=0)throw Error('Invalid preview media identity');
  const {shell,clean,instruction}=previewReviewShell({inlineData:{mimeType:'video/mp4',data:''},videoMetadata:{fps:5}},input);
  if(Buffer.byteLength(JSON.stringify(shell))+4*Math.ceil(bytes/3)>INLINE_REQUEST_MAX_BYTES)throw Error('Preview exceeds bounded inline request size');
  return {input:clean,video_sha256:sha256,input_sha256:hash(JSON.stringify(clean)),instruction_sha256:hash(instruction),version:PREVIEW_REVIEW_VERSION,
    logical_request_sha256:videoRequestDigest(shell,{sha256,bytes})};
}
export function buildPreviewReviewRequest(video: VideoInput, input: PreviewReviewInput) {
  const media=videoInput(video),{shell,clean,instruction}=previewReviewShell(media.part,input);
  const body = JSON.stringify(shell);
  if (Buffer.byteLength(body) > INLINE_REQUEST_MAX_BYTES) throw new Error('Inline request exceeds size limit');
  return { body, input: clean, video_sha256: media.sha256, input_sha256: hash(JSON.stringify(clean)),
    instruction_sha256: hash(instruction), request_sha256: hash(body), version: PREVIEW_REVIEW_VERSION,
    media_transfer: media.receipt };
}

/** The first physical segment has no predecessor. This boundary marker is not frame evidence. */
function filmOriginPrevious(row:Record<string,unknown>,input:PreviewReviewInput){
  const unit=input.units.find(u=>u.unit_id===row.unit_id);
  if(unit?.output_range_seconds?.[0]!==0||!Array.isArray(row.current)
    ||!row.current.some(e=>object(e)&&e.start_seconds===0&&typeof e.end_seconds==='number'&&e.end_seconds>0)
    ||!Array.isArray(row.previous))return false;
  if(!row.previous.length)return true;
  const p=row.previous[0];
  return row.previous.length===1&&object(p)&&p.start_seconds===0&&p.end_seconds===0
    &&p.channel==='visual_organization'&&text(p.observed)&&(p.quote===undefined||p.quote==='');
}

export function evaluatePreviewTeachingJudgment(value: unknown, input: PreviewReviewInput) {
  const issues: string[] = [];
  const receipt = (v: unknown): v is ReviewReceipt => object(v) && range(v, input.duration_seconds,true)
    && (typeof v.channel === 'string' && ['original', 'narration', 'annotation', 'visual_organization'].includes(v.channel))
    && text(v.observed) && (v.quote === undefined || text(v.quote) || (v.quote === '' && ['original','visual_organization'].includes(String(v.channel))));
  const receipts = (v: unknown): v is ReviewReceipt[] => Array.isArray(v) && v.every(receipt);
  const finding = (v: unknown): v is Finding => object(v)
    && (typeof v.status === 'string' && ['supported', 'not_supported', 'insufficient_evidence'].includes(v.status))
    && text(v.reasoning) && receipts(v.evidence);
  if (!object(value) || !Array.isArray(value.coverage) || !Array.isArray(value.continuity)) {
    return { status: 'review_required' as const, issues: ['invalid_judgment_schema'], unit_results: [], full_film_accepted: false as const };
  }
  const continuityRows: unknown[] = value.continuity;
  const covered = new Set<string>();
  const positive = (f: Finding, teaching: boolean, id: string) => {
    if (f.status !== 'supported') { issues.push(`${id}:${f.status}`); return; }
    if (!f.evidence.length) issues.push(`${id}:unsupported_positive`);
    if (teaching && !f.evidence.some((e) => e.channel !== 'original')) issues.push(`${id}:appearance_not_teaching`);
    for (const e of f.evidence) {
      if (e.channel === 'narration' || e.channel === 'annotation') {
        const matchingText = input.reference_text.filter((r) => r.channel === e.channel
          && e.start_seconds < r.end_seconds && e.end_seconds > r.start_seconds)
          .sort((a, b) => a.start_seconds - b.start_seconds).map((r) => r.text).join(' ');
        if (!e.quote || !normalize(matchingText).includes(normalize(e.quote))) issues.push(`${id}:unverified_quote`);
      }
    }
  };
  for (const row of value.coverage) {
    if (!object(row) || !text(row.point_id) || !input.points.some((p) => p.point_id === row.point_id)
      || covered.has(row.point_id) || !receipts(row.depiction) || !finding(row.teaching)) { issues.push('invalid_coverage_row'); continue; }
    covered.add(row.point_id);
    positive(row.teaching, true, row.point_id);
    if(row.point_id.startsWith('delivery/')&&row.teaching.status==='supported'){
      const pointId=row.point_id,teaching=row.teaching,localized=input.visual_criteria?.some(c=>c.point_id===pointId&&c.pictureStage!==undefined);
      const windows=input.units.filter(unit=>unit.point_ids.includes(pointId)).map(unit=>unit.output_range_seconds);
      if(!windows.length||windows.some(window=>!window||!teaching.evidence.some(e=>e.channel==='visual_organization'&&(localized?e.start_seconds>=window[0]&&e.end_seconds<=window[1]:e.start_seconds<window[1]&&e.end_seconds>window[0]))))
        issues.push(`${row.point_id}:delivery_visual_evidence_missing_in_section`);
    }
  }
  for (const p of input.points) if (!covered.has(p.point_id)) issues.push(`${p.point_id}:missing_coverage`);
  if (!value.continuity.length) issues.push('missing_continuity');
  const units = new Set<string>();
  for (const row of value.continuity) {
    if (!object(row) || !text(row.unit_id) || units.has(row.unit_id) || !input.units.some((u) => u.unit_id === row.unit_id) || !Array.isArray(row.point_ids)
      || !row.point_ids.length || !row.point_ids.every((id) => input.points.some((p) => p.point_id === id))
      || !Array.isArray(row.previous) || (!receipts(row.previous)&&!filmOriginPrevious(row,input)) || !receipts(row.current)
      || !(typeof row.relation === 'string' && ['continuation', 'recap', 'new_information'].includes(row.relation))
      || !finding(row.narrative) || !finding(row.teaching)) { issues.push('invalid_continuity_row'); continue; }
    units.add(row.unit_id);
    const expected = input.units.find((u) => u.unit_id === row.unit_id)!;
    const window=expected.output_range_seconds;
    if(window&&input.visual_criteria?.some(c=>c.pictureStage!==undefined&&expected.point_ids.includes(c.point_id))&&row.teaching.status==='supported'){
      const located=(e:ReviewReceipt)=>e.channel==='visual_organization'&&e.start_seconds>=window[0]&&e.end_seconds<=window[1];
      if(!row.current.some(located)||!row.teaching.evidence.some(located))issues.push(`${row.unit_id}:visual_evidence_outside_requested_window`);
    }
    if (JSON.stringify([...row.point_ids].sort()) !== JSON.stringify([...expected.point_ids].sort())) issues.push(`${row.unit_id}:unit_point_mismatch`);
    if ((!row.previous.length&&!filmOriginPrevious(row,input)) || !row.current.length) issues.push(`${row.unit_id}:missing_front_back_evidence`);
    positive(row.narrative, false, `${row.unit_id}:narrative`);
    positive(row.teaching, true, `${row.unit_id}:teaching`);
    for (const e of row.teaching.evidence) if (!row.current.some((c) => e.start_seconds < c.end_seconds && e.end_seconds > c.start_seconds)) {
      issues.push(`${row.unit_id}:teaching_evidence_outside_current`);
    }
  }
  for (const unit of input.units) if (!units.has(unit.unit_id)) issues.push(`${unit.unit_id}:missing_continuity`);
  // Preserve the model's narrative opinion, but a unit cannot waive its own missing focus points.
  const unit_results = input.units.map((unit) => {
    const rawUnit = continuityRows.find((r) => object(r) && r.unit_id === unit.unit_id);
    const unitIssues = issues.filter((issue) => issue.startsWith(`${unit.unit_id}:`)
      || unit.point_ids.some((id) => issue.startsWith(`${id}:`)));
    return { unit_id: unit.unit_id,
      model_narrative: object(rawUnit) && finding(rawUnit.narrative) ? rawUnit.narrative.status : 'insufficient_evidence',
      teaching_status: unitIssues.length ? 'review_required' as const : 'pass' as const,
      issues: unitIssues };
  });
  return { status: issues.length ? 'review_required' as const : 'pass' as const,
    issues, unit_results, full_film_accepted: false as const };
}

/** Re-evaluate only bounded observation/origin contract rejections, retaining the immutable original result.
 * Negative judgments, missing quotes, incomplete generation and real overruns never qualify. */
export function previewBoundaryRevalidation(result:unknown,input:PreviewReviewInput){
  if(!object(result)||result.status!=='review_required'||typeof result.raw_public_judgment!=='string'
    ||JSON.stringify(parsePreviewTeachingJudgment(result.raw_public_judgment))!==JSON.stringify(result.judgment)||!Array.isArray(result.finish_reasons)
    ||result.finish_reasons.length!==1||result.finish_reasons[0]!=='STOP'||!Array.isArray(result.issues)||!result.issues.length)return null;
  if(evaluatePreviewTeachingJudgment(result.judgment,input).status!=='pass'||!object(result.judgment))return null;
  const j=result.judgment as unknown as PreviewTeachingJudgment;
  const originIds=new Set(j.continuity.filter(row=>filmOriginPrevious(row as unknown as Record<string,unknown>,input)).map(row=>row.unit_id));
  const missingPrevious=':missing_front_back_evidence';
  if(!result.issues.every(i=>typeof i==='string'&&(/^(invalid_coverage_row|invalid_continuity_row)$/.test(i)
    ||/:(missing_coverage|missing_continuity)$/.test(i)
    ||i.endsWith(missingPrevious)&&originIds.has(i.slice(0,-missingPrevious.length)))))return null;
  const receipts=[...j.coverage.flatMap(c=>[...c.depiction,...c.teaching.evidence]),...j.continuity.flatMap(c=>[...c.previous,...c.current,...c.narrative.evidence,...c.teaching.evidence])];
  const origin=j.continuity.some(row=>filmOriginPrevious(row as unknown as Record<string,unknown>,input));
  if(!origin&&!receipts.some(e=>e.end_seconds>input.duration_seconds))return null;
  return {method:origin?'film-origin-continuity-v1':'observation-centisecond-eof-v1',original_status:result.status,original_issues:[...result.issues],
    raw_judgment_sha256:hash(String(result.raw_public_judgment)),time_precision_seconds:0.01,
    max_eof_rounding_seconds:0.005,scope:origin?'first_segment_has_no_predecessor_not_frame_evidence':'observation_times_only_not_edit_boundaries'};
}

/** Remove only a complete Markdown JSON envelope; never repair JSON or rewrite judgments. */
export function parsePreviewTeachingJudgment(raw: string): unknown {
  const trimmed = raw.trim();
  const envelope = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  try { return JSON.parse(envelope ? envelope[1] : trimmed); } catch { return null; }
}

/** One call, no hidden repair/retry/provider switch. Errors never echo keys or upstream bodies. */
export async function reviewClipMentorPreview(
  video: VideoInput, input: PreviewReviewInput,
  deps: { key: string; signal?: AbortSignal; post: (body: string, key: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }> },
) {
  if (!deps.key.trim() || /[\r\n]/.test(deps.key)) throw new Error('Preview review server credential unavailable');
  const request = buildPreviewReviewRequest(video, input);
  let response: { status: number; body: unknown };
  const signal=deps.signal ? AbortSignal.any([deps.signal,AbortSignal.timeout(PREVIEW_REVIEW_TIMEOUT_MS)]) : AbortSignal.timeout(PREVIEW_REVIEW_TIMEOUT_MS);
  signal.throwIfAborted();
  try { response = await deps.post(request.body, deps.key, signal); }
  catch { throw new Error('Preview review transport failed; attempt consumed, no automatic retry'); }
  if(response.status!==200)return interpretPreviewResponse(response,request,deps.key);
  if(JSON.stringify(response.body)?.includes(deps.key)||echoesMediaSecret(response.body,videoInput(video)))throw Error('Preview review response rejected for credential echo');
  return interpretPreviewResponse(response,request,deps.key);
}

/** Parse an already-saved response; no transport and no approval mutation. */
export function interpretPreviewResponse(response:{status:number;body:unknown},request:Omit<ReturnType<typeof buildPreviewReviewRequest>,'body'>,key:string){
  if (response.status !== 200) throw new Error(`Preview review HTTP ${Number.isInteger(response.status) ? response.status : 'error'}; attempt consumed, no automatic retry`);
  if (!object(response.body) || !Array.isArray(response.body.candidates)) throw new Error('Invalid preview review response; no automatic retry');
  const publicParts: string[] = [];
  const finishes: string[] = [];
  for (const c of response.body.candidates) {
    if (!object(c)) continue;
    if (text(c.finishReason)) finishes.push(c.finishReason);
    if (object(c.content) && Array.isArray(c.content.parts)) for (const part of c.content.parts) {
      if (object(part) && !part.thought && typeof part.text === 'string') publicParts.push(part.text);
    }
  }
  const raw = publicParts.join('\n');
  if (key&&raw.includes(key)) throw new Error('Preview review response rejected for credential echo');
  const judgment = parsePreviewTeachingJudgment(raw);
  const evaluation = evaluatePreviewTeachingJudgment(judgment, request.input);
  if (finishes.length !== 1 || finishes[0] !== 'STOP') {
    evaluation.status = 'review_required'; evaluation.issues.push('incomplete_generation');
  }
  return { scope: 'semantic_review_not_final_acceptance' as const, version: request.version,
    requested_model: PREVIEW_REVIEW_MODEL,
    returned_model: text(response.body.modelVersion) && (!key||!response.body.modelVersion.includes(key)) ? response.body.modelVersion : null,
    video_sha256: request.video_sha256, input_sha256: request.input_sha256,
    instruction_sha256: request.instruction_sha256, request_sha256: request.request_sha256,
    media_transfer: request.media_transfer,
    generation_options: { maxOutputTokens: PREVIEW_REVIEW_MAX_OUTPUT_TOKENS, fps: 5, temperature: 0 },
    raw_public_judgment: raw, judgment,
    usage: response.body.usageMetadata, finish_reasons: finishes, requests_attempted: 1,
    ...evaluation };
}
