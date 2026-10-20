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
  {
    name:'read_clipmentor_source_video',
    description:'Read a saved source-video observation receipt by operationId, including failures, exact validation diagnostics, raw observations and an explicitly saved offline revalidation. No model call, retry, approval or project mutation. Host marks current/stale by source hash and current revision/content digest. Original failed status is retained even if offline structure validation is now valid. Inspect semantic caveats separately; not actual edited handoff or film acceptance.',
    input_schema:{type:'object',additionalProperties:false,properties:{operationId:{type:'string',format:'uuid'}},required:['operationId']},
  },
  {
    name: 'observe_clipmentor_source_video',
    description: 'ONE explicitly authorized Gemini 3.8 continuous ORIGINAL video plus synchronized source audio observation via server. Host freezes current copy, picture plans and source windows; no author verdict input. Checks source action sequence, candidate endpoints and planned narration capacity. NOT actual edited handoff, synthesized narration listening, caption sync, copy approval or film acceptance. Read-only project; exact result retained in server ledger. Failed/unknown calls consume budget; never automatically retry or change operationId. Requires saved current picture plans and host project/run context.',
    input_schema: {type:'object',additionalProperties:false,properties:{
      operationId:{type:'string',format:'uuid'},maxRequests:{type:'integer',const:1},expectedRevision:{type:'integer',minimum:1},
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
      view: { type: 'string', enum: ['full', 'source_breakdown', 'current_copy', 'evidence', 'copy_review'], description: 'Default full retains history. source_breakdown: authoritative plan. current_copy: selected copy and picture plans only. copy_review: persisted independent receipt metadata, all findings and typed teaching judgments, operation ID and current/stale binding. Read saved results without requesting another review; a historical pass is not a current approval.' },
      reviewPart: { type: 'string', enum: ['result', 'packet'], description: 'Only with copy_review. Default result includes every judgment but omits the bulky input packet. packet requires unitId and adds that unit\'s frozen reviewed input and referenced evidence (not its current replacement). Read each receipt unit to recover the complete frozen packet without loading history.' },
      evidenceIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1 }, description: 'With view=evidence: read selected existing evidence records, directly linked frame records and observation metadata; no images, extraction or model call.' },
      unitId: { type: 'string', description: 'With current_copy, select one blueprint unit. With copy_review, optionally filter receipt judgments to one reviewed unit; required for reviewPart=packet. The receipt verdict remains the whole-review verdict, not a new per-unit approval.' },
    }, additionalProperties: false },
  },
  {
    name: 'revise_clipmentor_analysis',
    description: 'Reversible project-only analysis write. import: portable Teashell historical input, no overwrite. revise: replace an existing record by ID; wordIndex/endSeconds correct one transcript endpoint. append: add candidate records {product?,evidence?,points?,blueprint?,transcripts?}, never approvals or overwrites. Evidence status by kind: original_claim=candidate_unverified_speech; visible_action=agent_observed_candidate; expression_analysis_not_verified_causal_effect=inferred_not_verified_causal_effect; operator_supplied=operator_provided_not_independently_verified. Visible actions require observation_id and returned frame IDs, observation_method=main_agent_direct_image_read_not_independently_verified, call_status=unknown. New points status=candidate, review_status=pending. Supplemental transcripts status=operator_provided_segment_text_not_independently_listened; coarse segment times, no invented word alignment. Keep unclear speech unknown, do not infer efficacy or causality from actions. Use current expectedRevision. No timeline/model calls/local paths.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['import', 'revise', 'append', 'set_source_breakdown', 'set_picture_plan', 'select_copy_lines'] },
        expectedRevision: { type: 'integer', minimum: 0 },
        actor, reason: { type: 'string', minLength: 1 },
        assetId: { type: 'string' },
        fixture: { type: 'string', const: 'teashell_historical_v1', description: 'Import the bundled historical development fixture without copying its large JSON through chat. Mutually exclusive with input.' },
        input: { type: 'object', description: 'Teashell historical pack {inventory,frame_manifest,copy_input,transcripts:[{source_id,data}]}. File contents, not paths.' },
        collection: { type: 'string', enum: ['evidence', 'points', 'blueprint', 'transcripts'] },
        id: { type: 'string' },
        wordIndex: { type: 'integer', minimum: 0, description: 'Zero-based transcript word index; use only with collection=transcripts and endSeconds, not record.' },
        endSeconds: { type: 'number', minimum: 0, description: 'Explicit corrected source end time; code rejects values outside the word/source, never auto-clamps.' },
        record: { type: 'object', description: 'For select_copy_lines: id=unit_id, record={source_candidate_id:current candidate,candidate_id:new script_candidate_ ID,line_ids:ordered existing IDs,plan_id:new picture_plan_ ID,plan:updated picture plan,line_guidance:string}. Atomically selects existing words verbatim and binds the pending plan; plan.selected_narration must match the selected existing lines (extra audio metadata allowed). Keep every explain point covered. No new wording, history overwrite or production permission. For set_picture_plan: id=unit_id, record={plan_id:new picture_plan_ ID,script_candidate_id:current candidate,plan:object,line_guidance:string}. Saves only that pending plan/pointer and guidance, retaining all copy and history; never approval. Otherwise complete replacement record retaining its stable ID; no review/audit edits. For set_source_breakdown: {version:1,segments,points,units}; see pre-edit-analysis.md. Never drop old point or segment IDs; changing a point requires a new change_reason. Incomplete coverage stays review_required. Does not approve copy or film.' },
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
