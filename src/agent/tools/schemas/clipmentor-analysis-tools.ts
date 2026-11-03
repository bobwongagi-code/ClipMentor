import type { AgentToolSchema } from '../../tool-schema';

const actor = {
  type: 'object', additionalProperties: false,
  properties: {
    operator: { type: 'string', minLength: 1 },
    executor: { type: 'string', minLength: 1 },
    instruction: { type: 'string', minLength: 1, description: 'Actual operator instruction reference/quote; never fabricate human approval.' },
    identity: { type: 'string', const: 'local_declared_not_authenticated' },
  }, required: ['operator', 'executor', 'instruction', 'identity'],
};
export const CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS: AgentToolSchema[] = [
  {name:'render_clipmentor_review_board',description:'Generate a single-file offline INTERNAL blueprint review board from the current saved project. Read-only for project/media; no provider, network media, review, TTS or production render. view=human combines Chinese-first teaching cards and layout illustrations for the current saved project, including only its registered creator ending(s); two endings require an explicit complete candidate via the CLI; view=planner retains phase-order diagnostics. Both are internal, not creator Storyboard or semantic approval. Returns artifact paths/counts, not images. Requires host auto-save; never invent a save tool. No approval is granted. Local unregistered candidate JSON uses board:clipmentor-blueprint with explicit material bindings.',input_schema:{type:'object',properties:{view:{type:'string',enum:['human','planner'],description:'human for human review; planner for unchanged phase diagnostics. Omission keeps planner compatibility.'}},additionalProperties:false}},
  {
    name:'edit_clipmentor_preview',
    description:'Read/apply/render ONE host-authorized local preview revision. Read the immutable server permit first; For overlay mode, apply requires an independently inspected tailFrame. For an explicitly authorized narration merge, omit tailFrame; server-defined frame/audio cuts and existing-caption reuse are immutable. Creates a new native baseline-based timeline, preserves all old timelines and all content outside the explicitly authorized cuts/patches. No new narration or rewriting. No model/API can create a permit. Exact project/source hashes and approved changes are checked on every operation. Render budget is one, failures consume it. Does NOT waive copy/teaching review or approve the film. No TTS, rewrite or unrelated edits.',
    input_schema:{type:'object',additionalProperties:false,properties:{
      action:{type:'string',enum:['read','apply','render']},operationId:{type:'string',format:'uuid'},
      tailFrame:{type:'integer',minimum:0,description:'Only apply: actually inspected final displayed source frame, must be within host-approved candidates.'},
    },required:['action','operationId']},
  },
  {
    name: 'review_clipmentor_preview',
    description: 'One explicitly authorized continuous rendered MP4 plus synchronized audio review using Gemini 3.8. request: pass immutable uploaded preview src/hash, actual executionManifest and neutral goals/reference copy, not author verdicts. Manifest is frozen server-side, not sent to the independent model. read: zero model requests; checks saved observations against the frozen manifest. Legacy reads may supply executionManifest plus videoSha256 for diagnostic comparison only, never to upgrade old approval. ok/completed means retrieval only: use effective_review.status/can_use_as_pass; conflicts, unknown evidence or missing/unbound manifests require review even when raw judgment says supported/pass. Preserve raw findings. No rewrite, project mutation or final acceptance. Failed/unknown request counts; never change operationId to retry.',
    input_schema: {type:'object',additionalProperties:false,properties:{
      action:{type:'string',enum:['request','read']},operationId:{type:'string',format:'uuid'},
      maxRequests:{type:'integer',const:1},src:{type:'string'},videoSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
      input:{type:'object',description:'duration_seconds, points[{point_id,teaching_goal_zh,product_relevance}], units[{unit_id,point_ids,output_range_seconds?:[start,end]}], reference_text[{channel:narration|annotation,start_seconds,end_seconds,text}]. Exact preview/output times, legitimate goals and actual copy only. No prior verdicts.'},
      executionManifest:{type:'object',description:'Actual frame-based scenes/audios execution record for this exact preview, same object used by verify_export. request freezes it; read uses frozen copy. Legacy read may supply it with videoSha256, but remains unbound/review_required. Never hand-fill a substitute Shot table.'},
    },required:['action','operationId']},
  },
  {
    name:'read_clipmentor_source_video',
    description:'Read a saved source-video observation receipt by operationId, including failures, exact validation diagnostics, raw observations and an explicitly saved offline revalidation. No model call, retry, approval or project mutation. Host marks current/stale by source hash and current revision/content digest. Original failed status is retained even if offline structure validation is now valid. Inspect semantic caveats separately; not actual edited handoff or film acceptance.',
    input_schema:{type:'object',additionalProperties:false,properties:{operationId:{type:'string',format:'uuid'}},required:['operationId']},
  },
  {
    name: 'observe_clipmentor_source_video',
    description: 'ONE explicitly authorized Gemini 3.8 continuous ORIGINAL video plus synchronized source audio observation via server. Host freezes current copy, picture plans and source windows; no author verdict input. Optional observationTask adds neutral speech-boundary/material-continuity goals and context ranges ONLY for observation, never new production ranges. The full source MP4 is sent; synthesized narration is not heard. Unknown speech remains unknown. NOT actual edited handoff, caption sync, copy approval or film acceptance. Read-only project; exact result retained in server ledger. Failed/unknown calls consume budget; never automatically retry or change operationId. Requires saved current picture plans and host project/run context.',
    input_schema: {type:'object',additionalProperties:false,properties:{
      operationId:{type:'string',format:'uuid'},maxRequests:{type:'integer',const:1},expectedRevision:{type:'integer',minimum:1},
      observationTask:{type:'object',additionalProperties:false,properties:{
        version:{type:'string',const:'source-boundaries-v1'},
        contexts:{type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,properties:{
          context_id:{type:'string',pattern:'^[\\w:-]{1,80}$'},unit_id:{type:'string',minLength:1},
          source_range_seconds:{type:'array',minItems:2,maxItems:2,items:{type:'number',minimum:0}},
          boundary_seconds:{type:'array',maxItems:16,uniqueItems:true,items:{type:'number',minimum:0}},
          goals:{type:'array',minItems:1,maxItems:2,uniqueItems:true,items:{type:'string',enum:['speech_boundaries','material_continuity']}},
        },required:['context_id','unit_id','source_range_seconds','boundary_seconds','goals']}},
      },required:['version','contexts']},
    },required:['operationId','maxRequests','expectedRevision']},
  },
  {
    name: 'request_clipmentor_copy_review',
    description: 'Request ONE explicitly authorized independent local-Codex review of the current copy and current picture plans. Host builds the packet and source frames; a fresh isolated reviewer has no edit/signing tools. Saves its exact-version receipt through the undoable draft, including failures. Not a point confirmation or full-video acceptance. Stable operationId; failed/unknown attempts count, no automatic retries. Cannot accept author verdicts. Requires host run/project context and a saved current picture plan for every current copy unit.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      operationId: { type: 'string', format: 'uuid' }, maxRequests: { type: 'integer', const: 1 },
      expectedRevision: { type: 'integer', minimum: 1 },
    }, required: ['operationId', 'maxRequests', 'expectedRevision'] },
  },
  {
    name: 'observe_clipmentor_source',
    description: 'Return 1–8 clear individual original-source JPEGs (source ratio, max long edge1280, no upscaling), with image-index/time/frame-ID mapping. Supply seconds for overview/detail or sequence {startSeconds,endSeconds,count:2..8} for a dense short-action window; mutually exclusive. Sample full source, then inspect unclear or brief actions at a denser interval. Frame coordinates are requested source positions, not measured PTS. No ASR or separate vision-model call; no approval. Read actual images, append observations separately from buying-reason interpretations. Unknown speech does not block visual analysis.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { seconds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'number', minimum: 0 } },
        sequence: { type: 'object', additionalProperties: false,
          properties: { startSeconds: { type: 'number', minimum: 0 }, endSeconds: { type: 'number', minimum: 0 }, count: { type: 'integer', minimum: 2, maximum: 8 } },
          required: ['startSeconds', 'endSeconds', 'count'] },
        expectedRevision: { type: 'integer', minimum: 1 }, actor, reason: { type: 'string', minLength: 1 } },
      required: ['expectedRevision', 'actor', 'reason'],
      oneOf: [{ required: ['seconds'], not: { required: ['sequence'] } }, { required: ['sequence'], not: { required: ['seconds'] } }],
    },
  },
  {
    name: 'transcribe_clipmentor_source',
    description: 'Paid original-video ASR via the approved server-side Singapore Fun-ASR route. Asset only; no timeline placement or caption edits. Initializes a fresh analysis with machine transcript and provenance ONLY, no selling-point extraction or approvals. Requires explicit request budget and stable UUID operationId. Failures count; never automatically retry with a new operationId. Same ID reuses a completed server result or refuses an uncertain attempt. Default language is auto, never guess ms. Report progress/results in Chinese.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        assetId: { type: 'string', minLength: 1 },
        operationId: { type: 'string', format: 'uuid', description: 'Stable UUID v4 for this authorized attempt; retain for outcome recovery.' },
        maxRequests: { type: 'integer', minimum: 1, maximum: 100, description: 'Explicit cap on provider requests including failed calls. No retries. Each <=240s chunk consumes one request.' },
        language: { type: 'string', pattern: '^(auto|[a-z]{2,3})$', default: 'auto' },
        expectedRevision: { type: 'integer', const: 0 }, actor, reason: { type: 'string', minLength: 1 },
      }, required: ['assetId', 'operationId', 'maxRequests', 'expectedRevision', 'actor', 'reason'],
    },
  },
  {
    name: 'read_clipmentor_analysis',
    description: 'Read project-owned analysis, source_breakdown ledger, deterministic plan issues and actual timeline/source bindings. structurally_ready is NOT semantic or full-film approval. Missing coverage, changed source ranges and undeclared revisits require repair. Pending/unknown source statuses remain unchanged.',
    input_schema: { type: 'object', properties: {
      view: { type: 'string', enum: ['full', 'source_breakdown', 'current_copy', 'evidence', 'copy_review'], description: 'Default full retains history. source_breakdown: authoritative plan. current_copy: selected copy and picture plans; use copyPart plus unitId to avoid loading historical or large plan data. copy_review: persisted independent receipt metadata, all findings and typed teaching judgments, operation ID and current/stale binding. Read saved results without requesting another review; a historical pass is not a current approval.' },
      copyPart: { type: 'string', enum: ['all', 'summary', 'candidate', 'picture_plan'], description: 'Only current_copy. Default all preserves legacy output. Other parts require unitId: summary returns pointers and line IDs; candidate returns current narration, caption_lines, zh, point_ids, source_seconds and labels without unrelated metadata; picture_plan returns only the current picture plan. Read parts separately; no historical blueprint read is required to register a new local candidate.' },
      reviewPart: { type: 'string', enum: ['result', 'packet'], description: 'Only with copy_review. Default result includes every judgment but omits the bulky input packet. packet requires unitId and adds that unit\'s frozen reviewed input and referenced evidence (not its current replacement). Small reads retain the object result; large packet reads automatically return bounded exact JSON pages instead of truncation. Continue with packetOffset=next_offset and the same packetDigest until null; concatenate json_text in offset order. A last page alone is not complete self-verification. No new review or approval.' },
      packetOffset: { type: 'integer', minimum: 0, description: 'Only copy_review/packet with unitId. UTF-16 character offset into the exact frozen unit packet envelope; default 0 for automatic paging. Use returned next_offset. Any offset >0 requires packetDigest.' },
      packetLimit: { type: 'integer', minimum: 256, maximum: 6000, description: 'Only with packetOffset; bounded frozen JSON page size, default 6000. Does not raise model or transport limits.' },
      packetDigest: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Frozen-page digest from the first page; required after offset 0. Rejects mixed-version pages. Current/stale binding and production gate remain separate.' },
      evidenceIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1 }, description: 'With view=evidence: read selected existing evidence records, directly linked frame records and observation metadata; no images, extraction or model call.' },
      unitId: { type: 'string', description: 'With current_copy, select one blueprint unit. With copy_review, optionally filter receipt judgments to one reviewed unit; required for reviewPart=packet. The receipt verdict remains the whole-review verdict, not a new per-unit approval.' },
    }, additionalProperties: false },
  },
  {
    name: 'revise_clipmentor_analysis',
    description: 'Reversible project-only analysis write. set_copy_candidate: atomically register a new unit-local copy candidate and picture plan without loading/replacing historical blueprint; read current_copy with copyPart first. import: portable Teashell historical input, no overwrite. revise: replace an existing record by ID; wordIndex/endSeconds correct one transcript endpoint. append: add candidate records {product?,evidence?,points?,blueprint?,transcripts?}, never approvals or overwrites. Evidence status by kind: original_claim=candidate_unverified_speech; visible_action=agent_observed_candidate; expression_analysis_not_verified_causal_effect=inferred_not_verified_causal_effect; operator_supplied=operator_provided_not_independently_verified. Visible actions require observation_id and returned frame IDs, observation_method=main_agent_direct_image_read_not_independently_verified, call_status=unknown. New points status=candidate, review_status=pending. Supplemental transcripts status=operator_provided_segment_text_not_independently_listened; coarse segment times, no invented word alignment. Keep unclear speech unknown, do not infer efficacy or causality from actions. Use current expectedRevision. No timeline/model calls/local paths.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['import', 'revise', 'append', 'set_source_breakdown', 'set_picture_plan', 'set_copy_candidate', 'select_copy_lines'] },
        expectedRevision: { type: 'integer', minimum: 0 },
        actor, reason: { type: 'string', minLength: 1 },
        assetId: { type: 'string' },
        fixture: { type: 'string', const: 'teashell_historical_v1', description: 'Import the bundled historical development fixture without copying its large JSON through chat. Mutually exclusive with input.' },
        input: { type: 'object', description: 'Teashell historical pack {inventory,frame_manifest,copy_input,transcripts:[{source_id,data}]}. File contents, not paths.' },
        collection: { type: 'string', enum: ['evidence', 'points', 'blueprint', 'transcripts'] },
        id: { type: 'string' },
        wordIndex: { type: 'integer', minimum: 0, description: 'Zero-based transcript word index; use only with collection=transcripts and endSeconds, not record.' },
        endSeconds: { type: 'number', minimum: 0, description: 'Explicit corrected source end time; code rejects values outside the word/source, never auto-clamps.' },
        record: { type: 'object', description: 'For set_copy_candidate: id=unit_id, record={source_candidate_id:current candidate,candidate_id:new script_candidate_ ID,lines:[{id,point_ids,narration_ms,caption_lines,zh,source_seconds,labels?,labels_zh?}],plan_id:new picture_plan_ ID,plan:compact current picture plan,line_guidance:string}. Atomically saves the complete ordered new unit copy and its plan, without reading/replacing the historical blueprint. Optional labels_zh must match labels one-to-one; original_claim evidence may carry optional meaning_zh for internal human reading. These planner translations never enter the independent reviewer projection. No other line keys. Captions must match narration, ranges must be in source, all explain points stay covered; Chinese meaning is required but not semantically certified. Host binds selected_narration and the new script ID, forces candidate/pending/production_allowed=false and retains history. No approval or timeline change. For select_copy_lines: id=unit_id, record={source_candidate_id:current candidate,candidate_id:new script_candidate_ ID,line_ids:ordered existing IDs,plan_id:new picture_plan_ ID,plan:updated picture plan,line_guidance:string}. Atomically selects existing words verbatim and binds the pending plan; plan.selected_narration must match the selected existing lines (extra audio metadata allowed). Keep every explain point covered. No new wording, history overwrite or production permission. For set_picture_plan: id=unit_id, record={plan_id:new picture_plan_ ID,script_candidate_id:current candidate,plan:object,line_guidance:string}. Saves only that pending plan/pointer and guidance, retaining all copy and history; never approval. Otherwise complete replacement record retaining its stable ID; no review/audit edits. For set_source_breakdown: {version:1,segments,points,units}; see pre-edit-analysis.md. Never drop old point or segment IDs; changing a point requires a new change_reason. Incomplete coverage stays review_required. Does not approve copy or film.' },
        records: { type: 'object', additionalProperties: false,
          properties: { product: { type: 'object' }, evidence: { type: 'array', items: { type: 'object' } },
            points: { type: 'array', items: { type: 'object' } }, blueprint: { type: 'array', items: { type: 'object' } },
            transcripts: { type: 'array', items: { type: 'object' } } },
          description: 'append only. Complete records follow ClipMentorAnalysis. Read the skill reference pre-edit-analysis.md for field examples. Existing records and raw ASR are retained.',
        },
      }, required: ['action', 'expectedRevision', 'actor', 'reason'],
    },
  },
  {
    name: 'review_clipmentor_analysis',
    description: 'Record an explicitly operator-requested point confirmation or request for revision, with declared operator/executor and instruction provenance. This is local declared identity, NOT authenticated human verification. Never self-approve or treat this as audio/visual acceptance. Source hash and structural evidence checks must pass before confirmation.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        pointId: { type: 'string', minLength: 1 },
        state: { type: 'string', enum: ['confirmed', 'needs_revision'] },
        expectedRevision: { type: 'integer', minimum: 1 },
        actor, reason: { type: 'string', minLength: 1 },
      }, required: ['pointId', 'state', 'expectedRevision', 'actor', 'reason'],
    },
  },
];
export const CLIPMENTOR_ANALYSIS_TOOL_NAMES = new Set(CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS.map((t) => t.name));

/** Internal host tools must never be activated in a browser session. */
export const CLIPMENTOR_SERVER_TOOL_SCHEMAS: AgentToolSchema[] = [
  {name:'save_clipmentor_source_frame',description:'Save a hash-bound source-video frame as a reusable image asset with source provenance. Local extraction only, no model call. Available in server-owned production.',
   input_schema:{type:'object',additionalProperties:false,properties:{assetId:{type:'string'},seconds:{type:'number',minimum:0}},required:['assetId','seconds']}},
];
