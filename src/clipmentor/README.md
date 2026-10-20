# ClipMentor pre-edit analysis

## Controlled independent copy review (2026-10-19)

The built-in server-run Agent can now request the existing local Codex login in a fresh ephemeral, read-only reviewer context. No new provider, API key, UI or dependency is needed. After saving the current manuscript and a matching current picture plan for every selected unit, call:

```json
{"operationId":"a07ec895-e02d-42d8-a7e8-45de7ed04d36","maxRequests":1,"expectedRevision":1}
```

Use tool `request_clipmentor_copy_review` only with explicit authorization for one review turn; replace the example UUID and revision with the real stable operation/revision. Project and author-run identity come from the host, not model arguments. The tool builds the current packet and operational picture plans, removes author review/approval/reason metadata, and posts to the editor-authenticated `POST /api/clipmentor/review-copy`. The server verifies original upload bytes against the source hash and derives original/explanation source samples. The reviewer gets only a read-only fixed-frame tool, not editing/signing tools or author conversation history. Frame sampling is not continuous viewing, a rendered layout, listening or measured voice alignment.

The host stores raw judgments and a single-attempt ledger in the runtime profile's `clipmentor-copy-review` directory, then binds the matching-version result through the existing undoable draft. Failed semantic reviews are also saved and returned with point-level reasons. A changed project/source, incomplete inspection, malformed result or unknown outcome cannot become approval. The current whole-analysis receipt remains conservative: all selected units must pass, and revision/restoration invalidates the old receipt. Local self-check is preparation, not this independent permission. Final-preview L1/L2 and listening remain separate later checks.

Operation IDs never auto-retry. Completed repeats reuse the result (`cached:true`, `requestsSent:0`); failures retain their attempted count and cannot be replayed. Do not create a new ID to bypass a consumed authorization. The new path requires the built-in browser server-run context; unsupported callers without host project/run identity fail before requesting a model. Exact upstream model identity is not exposed by the existing Codex transport and is recorded as unknown, rather than fabricated.

Run `npm run verify:clipmentor-copy-review` for the real tool/draft/HTTP path with a fake reviewer, plus the actual Codex adapter against a fake RPC executable. These tests make no model calls. Live semantic quality and an actual-editor end-to-end run remain unverified. Earlier sections saying no review runner existed describe previous implementation stages; they do not describe this new entry point.

### Read an existing receipt without another review call

For an explicitly authorized deduplication, `revise_clipmentor_analysis(action="select_copy_lines", id=unit_id)` selects existing line IDs without rewriting the historical blueprint. Its record contains `source_candidate_id` (current), a fresh `candidate_id` beginning `script_candidate_`, ordered `line_ids`, a fresh `plan_id` beginning `picture_plan_`, an updated `plan` and `line_guidance`. The host copies the original lines verbatim, checks `plan.selected_narration` agrees and every explain point remains covered, and atomically updates both current pointers. Original candidates/plans and the old review stay intact; the result is pending, not production approval. This does not change source windows; use the existing source-breakdown revision separately to map the selected material.

Use `read_clipmentor_analysis` with `{"view":"copy_review"}` for every saved finding and typed teaching judgment, receipt revision/digest, reviewer identity and derived operation ID (null for legacy IDs). `binding` is current/stale/missing/unverifiable; it does not override `production_gate`. The original verdict remains readable after edits but cannot become a new approval.

The frozen input packet is separate to avoid the 16,000-character model-result cap: use `{"view":"copy_review","reviewPart":"packet","unitId":"U-02"}` for one reviewed unit and its referenced evidence, then repeat for other receipt units. This returns the input from that review, not today's replacement plan. `unit_filter` marks a projection; the receipt's overall verdict is unchanged. Reassemble packet units/evidence by ID if the whole frozen input is needed. These reads make no requests, writes, retries or new signatures. Use `current_copy` separately for the current draft when fixing findings.

## Source breakdown contract: analysis → copy → execution (2026-10-19)

Original playback and evidence indexing are distinct: `units[].original_source_ranges` is the authoritative complete original playback plan, including selected speech context; `original_segment_ids` indexes the teaching evidence inside it. Legacy records without explicit ranges fall back to indexed ranges. Review packets and timeline checks consume the same helper. Unknown unit fields remain readable in historical data but block readiness and new writes, so an invented playback authority cannot silently pass. Playback-only edits invalidate existing copy approval.

The project now owns one optional `source_breakdown` contract in its existing analysis record. Historical projects remain readable; ordinary editing projects do not acquire it. No new service, provider, dependency, UI, video splitting or model call was added. The full field/workflow reference ships with the Agent in [pre-edit-analysis.md](../agent/skills/clipmentor/references/pre-edit-analysis.md#source-breakdown-contract).

- Source `segments` reference visible actions, original claims and interpretations in separate typed evidence lists, with source times and unknowns. They index coherent information windows, not a mandatory shot-by-shot cut list.
- Selected `points` keep their buying concern, necessary filming conditions and teaching task before compression/localization. This is the downstream selected-task baseline; `analysis.points` remains the analysis findings collection. Revisions cannot drop old point/segment IDs. Corrections need a new reason; the author cannot waive primary/required status itself. Optional omission proposals remain recorded but do not receive an automatic independent scope waiver in this slice; do not write filler to manufacture a landing.
- `units` separate original playback from explanation ranges, account for every point and register meaningful revisit relationships. A reason is only accounting, not proof that visual-only treatment, a merge or an omission is justified. The independent per-point review still decides what the actual copy teaches.

The existing `revise_clipmentor_analysis` tool supports `action:"set_source_breakdown"` with the current `expectedRevision`, `actor`, `reason` and `record`. It is a reversible project update, not an approval. Missing source/reference information is rejected; incomplete coverage can be saved with explicit issues for the author to repair. Trying to save a new/replaced copy candidate without a ledger is refused. `read_clipmentor_analysis` returns both `breakdown_check` and `breakdown_timeline_check`, including specific point/unit/item IDs; no new tool name was necessary. Direct offline analysis writes were not previously implemented and remain outside this change; both normal and offline production dispatchers share the same release guards.

`copyTeachingPacketFromDoc(doc)` extracts the registered task scope and current text, including planned original/explanation source windows and line-by-line source windows. Pass it to `buildCopyTeachingReviewRequest`; author justifications, change reasons, self-ratings and prior answers are not included. Receipt verification checks the exact packet against the current ledger, so the review cannot quietly narrow a teaching question or replace the pre-copy baseline with a shortened manuscript. Any contract/copy/source revision invalidates the existing conservative whole-analysis receipt; restoring content through tools does not revive it. This does not introduce an automatic review runner or a claim that a semantic model cannot err.

When actual output positions are known, the Agent registers only `placement` timeline/phase windows. `checkSourceBreakdown(doc,true)` derives source intervals and item IDs from real video instances with the existing source-time helper, honoring playback rate and allowing a one-frame arithmetic tolerance. It compares planned and actual range coverage, ignores hidden/invisible clips and reports missing placements, mismatches and unsupported mappings. No hand-entered actual source ranges or clip IDs are trusted. Standard Agent `submit_render_job` / `submit_export` preflight is blocked until these checks pass; construction can remain incomplete while editing. This does not intercept the manual UI export button or inspect opacity/occlusion/cropping as a full visual check.

Automatic timeline coverage currently handles direct video with the known matching source/timeline frame clock. Nested sequences, nonlinear transcript cuts, unknown frame-clock conversions and static/composed evidence need review rather than a guessed match. This limitation is not an instruction to replace valid still/grid designs with chronological full-screen playback. Planned scope is checked, not the discovery of every important point, actual listening, continuous motion, subtitle reading speed or complete-film acceptance. The Teashell revision98 project, copy, audio, media and timelines were not migrated or edited by this implementation.

Verification is part of `npm run verify:clipmentor-analysis`. `source-breakdown.verify.ts` covers evidence separation, missing/changed task accounting, undeclared revisits, source changes, real revision-tool writes, copy-before-analysis refusal, stale approval after range-only changes/restoration, and both production dispatchers. Its portable `source-breakdown-v1r1.json` freezes 10 original video-item coordinates from the existing Teashell v1 snapshot; the teaching ledger is explicitly reconstructed from the documented failure, not a new independent analysis. The replay reports the lost required explanation, unregistered revisit and source-range mismatch. A reviewed positive reaches rendering preflight without a real render. Existing project-store/version/stream and legacy transfer tests retain the new ledger. These are structural regression tests, not a new blind semantic trial or an end-to-end built-in-Agent run on unseen video.

## Current: V2 per-point teaching review, balanced blind regression (2026-10-19)

**The V1 miss is preserved. V2 caught both rejected manuscripts and passed three scoped positive controls in one new blind review.** No production copy, audio, video or project was changed, and no production approval was issued. These are text/plan development regressions, not native-language, audio, continuous-video or whole-film acceptance.

### Why V1 passed revision95

The original reviewer explicitly noticed that the elbow/dark-area link could be stronger but called it optional, then used the valid scent sentence to justify the whole usage unit. Its schema only required a unit verdict and findings; `checkCopyProduction` could accept aggregate `pass` plus empty findings after method qualification. There was no required point-level account of what the audience actually learned. Thus concrete action, a generic filming purpose and a safe evidence boundary could be mistaken for explaining the product-specific teaching point. The supplied product concern was available; the failure was not simply missing background.

### Enforced handoff

`buildCopyTeachingReviewRequest` accepts a `TeachingPacket`: audience/product concerns, source observations/uncertainties, selected copy and a pre-copy teaching scope. Every scope point has an ID, a question, evidence IDs and a role (`primary`, `supporting`, `auxiliary`). Those roles/questions must come from the pre-copy point ledger, not the author's defense of the current draft or a reviewer's after-the-fact downgrade. The builder strips expected verdicts, host metadata and author self-review. Its exact protocol and semantically identical payload were used by the fresh independent reviewer; tests also verify the frozen input/protocol hashes.

The reviewer first reconstructs what a creator can learn, quotes the actual Malay narration/captions/labels, and classifies the connection and evidence boundary **for every point**. Background facts and Chinese meanings cannot fill a gap in the Malay copy. It does not provide the release verdict. `assessTeachingReview` computes that verdict: every primary point must connect filming to a concrete product concern; a strong scent point cannot compensate for an unexplained placement point. Supporting sequence/context and a brief auxiliary transition are allowed without repeating the entire purchase argument. No product-name rules, banned-word lists, preferred slang, mandatory marketing terms or case-specific rejection branches are used.

Missing/duplicate points, fabricated quotes, uncertain evidence, translation mismatch or dependence on background return revision/review status. `teaching_issues` carries unit/point IDs and reason codes back through the production guard, so a caller can address a specific gap rather than guessing or asking the operator to find it. This checks the **registered scope**; it cannot prove the original point ledger discovered every worthwhile feature, authenticate local run IDs, or guarantee the model classified semantics correctly.

`CopyProductionReview.teaching_review` stores the frozen packet and untouched typed judgments. The gate verifies the packet's selected lines/point coverage against the current candidate, evaluates it independently of an aggregate pass, and still binds the complete analysis/source revision and calibration evidence. V2 receipts need this envelope. V1 receipts stay V1 and are stale under `creator-copy-v2`; they are not silently upgraded. No automatic review runner, author-side signing tool or UI was added. The host can use the exported request/assessment/binding functions; the current project still has no new review receipt and must not proceed to production on this benchmark result alone.

### Frozen blind result

Inputs and expected statuses were frozen before starting **one** new independent Agent with no inherited conversation. It saw neither revision labels, control labels, expected answers nor author reasons; there was no induced re-answer. Narration/captions were reused verbatim from the existing files.

| Scoped sample | Result | Meaning |
| --- | --- | --- |
| revision90 usage + comparison | needs_revision | Abstract elbow/experience explanations were caught; the comparison unit itself was not forced to fail. |
| revision95 usage + comparison | needs_revision | Elbow point was `action_only`: where it was tried, without the dark-area/product concern link. Scent point remained valid and comparison unit remained pass. |
| Accepted revision78 comparison excerpt + original short labels | pass | Same-unit labels can carry the brightening topic; concise comparison need not claim proven efficacy. Not full-film approval. |
| Scent-only excerpt from revision95 | pass | A qualified local point, not an assertion that revision95 as a whole was qualified or user-approved. |
| Accepted NIUMO connector excerpt | pass | Changing a head is connected directly to carrying fewer cables. Only this point, not complete NIUMO selling-point coverage. |

The raw protocol, inputs, independent point judgments, pre-registration hashes and scoped oracles are in `fixtures/copy-teaching-blind-v2-20261019.json`. V1's raw failed calibration remains unchanged in its original fixture. `copyReviewCalibration()` now requires negative cases **and** positive controls to match; an always-reject reviewer cannot qualify. `qualified:true` has scope `development_regressions_only`, not generalization to unseen videos. A new natural video remains necessary to test that.

### Verification and limits

```bash
npm run verify:clipmentor-copy-review-regression
npm run verify:clipmentor-analysis
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit --incremental false
```

The regression command now passes for the new 2-negative/3-positive blind result. The mechanical suite additionally proves that a fabricated aggregate pass cannot bypass a missing primary assessment, missing quote, background-only inference or changed manuscript; both real dispatchers refuse TTS/editing. Reviewed positive preflight and disposable ClipMentor edits pass, so this is not a blanket lock. Existing missing/failed/stale/source-change/concurrent-change guards remain covered. All test network requests are trapped; no real TTS or production edit occurs.

Red/green was observed twice: the original aggregate-only gate accepted the missing-teaching probe before the change; an isolated copy with the three new teaching checks removed made the persistent regression test fail with `copy_and_plan_ready` instead of `copy_teaching_review_missing`. The actual code passed the same test; no live gate was disabled for this check. Application TypeScript and existing analysis/observation/offline-runtime checks passed. No full desktop rebuild, native listening review or film acceptance was performed. The known missing `onnxruntime-node` remains outside this change.

Internal delivery self-check: the root cause, new blind result and code checks are recorded separately; disagreement on comparison was preserved. No guarantee of zero future model errors is claimed. This section is an internal engineering record, not creator-facing teaching copy. Changes are uncommitted.


## Clear frames, short-action sampling and blueprint convergence (2026-10-16)

The analysis observation tool now requests `/api/extract-frames` with `output:"frames"`, yielding 1–8 individual JPEGs at source aspect ratio, no upscaling and max long edge1280. Existing callers without the option retain their old contact sheet. Each successful output retains its actual requested time, including after a failed middle extraction. The analysis client fails a partial/reordered/mismatched batch rather than assigning wrong IDs. Pass either `seconds:[...]` or `sequence:{startSeconds,endSeconds,count:2..8}`; the latter samples a chosen action window, rejecting out-of-range or duplicate-source-frame sequences. Optional `image_layout` and `sampling` metadata preserve old schema-v1 records. Single-frame `visible_action` evidence may use `[t,t]`; points and other intervals remain positive-length. This does not extend ASR times or invent action duration.

Real testing found the old browser-to-server projection dropped clear batches above768KiB. A shared bounded visual exception now admits up to8 valid base64 images with small metadata, total result<=4MiB; the HTTP hard cap is5MiB. Ordinary projection stays768KiB and non-visual request data stays within1MiB. Large text metadata cannot use the image exception. Existing capability/claim checks are unchanged. Tests prove large image bytes reach the consumer intact, ordinary oversized text and oversized images fail, and the legacy sheet is unchanged. The default interface-language prompt now allows an explicit output-language request to take precedence.

Live Teashell test `1504ecbe-3a95-45b8-ae57-c613e8393ad3` ultimately persisted46 sampled frames in6 batches (including2 sequences),3 pending points and3 source-ordered units at revision18. No external human Teashell answers or fixture were provided. After the initial draft was preserved, the main Agent identified a mismatch between the draft's broad time range and its one-frame citation, without supplying the missing action or product interpretation. The built-in Agent chose follow-up images and revised its own IDs. This is operator-guided self-review, not a one-shot or new-video autonomous-quality acceptance. Original outputs and later review are separate. A failed image-limit run, a hot-reload interruption and rejected instant-evidence saves remain recorded. The original project, earlier test projects, original ASR, media and timelines are unchanged; no ASR, review approval, voice or editing call was made. The current blueprint is ready for human review, not accepted film or complete analysis quality.

## Tool-image visibility fix and independent development run (2026-10-16)

This supersedes the unresolved visibility status in the historical run below. With the installed Codex CLI `0.162.0-alpha.17.2`, dynamic-tool image items followed by a text item caused image-preparation base64 decoding errors. The same original padded JPEG, model and runtime configuration produced visible-image descriptions when text preceded images. `server/codex/turn-manager.ts` now emits metadata text first, then the unchanged image payloads. Removing base64 padding did not fix the issue and is not part of the patch. A red/green test in `server/codex/codex-agent.verify.ts` checks ordering and unchanged multi-image payloads; an actual `/api/codex/turn` probe also succeeded. The AI SDK serializer is a separate path and was not changed. Both Codex execution routes share the fixed converter.

A fresh Teashell test project had only the original asset and existing 343-word machine transcript, with no chat, historical observations, candidate points, blueprint or approvals. The built-in Agent selected its own times: first 24 frames / 4 pending points (revision 5), then another 24 frames / 8 additional pending points after a generic self-review request (revision 9). Both original outputs were saved before the main Agent reviewed them. No Teashell-specific answers were supplied. Independent image perception is now observed; analysis quality is **not accepted**. The draft still under-explains product buying reasons, misses detail, duplicates blueprint alternatives and replies in English despite Chinese instructions. Static sampling is not continuous video viewing or listening. Raw ASR, protected projects, media and timelines remain unchanged; no additional ASR, review confirmation, synthesis or export occurred. The parent workspace contains raw traces, sampled images, verification assertions and a separate main-Agent review.

## Source observation and candidate findings (2026-10-16)

The current operator approved proceeding with the existing transcript and images, leaving unclear speech unknown. This supersedes the earlier all-analysis listening hold below. Exact ingredients, before/after identities, efficacy, purchase routes, counts and prices remain unknown unless supported by the appropriate evidence; existing machine words are not corrected or upgraded. No further ASR requests are authorized.

`observe_clipmentor_source {seconds:[...],expectedRevision,actor,reason}` samples 1–8 explicit original-source times through the existing local `/api/extract-frames` endpoint, using the current hash-bound managed source. It creates optional portable `observations` and frame evidence in `clipMentorAnalysis` and returns a contact-sheet image to the main Agent. It never calls a separate vision provider or changes the existing frame/vision tools. `images_returned` means extraction and return, not interpretation accuracy or human review. Failed or incomplete sheets are saved as failed attempts with no frame evidence, avoiding cell/time misbinding if the old endpoint skips a failed sample. The main Agent must actually receive/read the pictures, otherwise report unavailable and stop visual inference. Source times are requested source-frame coordinates, not measured presentation timestamps; exact PTS guarantees remain outside this slice.

`revise_clipmentor_analysis {action:"append",records:{product?,evidence?,points?,blueprint?,transcripts?},expectedRevision,actor,reason}` adds candidates to an existing source analysis without replacing prior records or approving points. Visible actions must reference frames from a successful observation, with Agent-declared direct image reading recorded separately from extraction. Original speech candidates reference a transcript; operator text, visible action and interpretation use separate kinds. New points stay `candidate` / `pending`. Missing references, duplicate IDs, failed frame claims, new out-of-range times and attempted review writes are refused. Supplemental text is explicitly segment-aligned/unverified, not fake word alignment. Existing raw ASR errors remain visible but do not block candidate observation/writing. Content changes invalidate dependent existing reviews. Candidate records are not product-performance certification or causal evidence for virality.

Load the bundled skill reference `references/pre-edit-analysis.md` for exact field examples and content criteria: complete-source sampling, targeted follow-up, product buying reasons, necessary filming conditions, source chronology and local uncertainty. The current route supports a main Agent that can see images; it does not silently add a paid vision fallback for a text-only model. No UI, rendering, export, caption, voice, transcript generation or provider routing changes are included.

`npm run verify:clipmentor-analysis` now includes `observation.verify.ts`: extraction/failure/time binding, candidate-only writes, preservation of unknown speech, stale/source rejection, project/version persistence and untouched media/timelines. Tests do not prove model analysis quality; a real built-in Agent development-sample run is recorded separately in the parent workspace.

Live development-sample result: four observation batches/32 source frames and five pending points were saved in the existing isolated Teashell ASR test project (revision 6), leaving original/media/timelines/raw ASR unchanged. The built-in Agent reported that returned images were not visible and did not invent findings. Direct Codex dynamic-tool image delivery reproduced the visibility failure; a code-mode-host-off probe also acknowledged `inputImage` but did not yield perception (its cleanup then errored, separately recorded). No unique underlying cause has been established and shared Codex/chat/vision configuration was not patched. Main Codex directly viewed local source frames and supplied the candidate findings; the built-in Agent only registered them. This is assisted analysis/storage validation, not autonomous visual analysis acceptance. Further independent-product work must resolve actual image visibility and test a new video without feeding the answers.

## Original-source Fun-ASR (2026-10-16)

The operator explicitly approved a **transcription-only direct Singapore Fun-ASR route**, with credentials managed on the server. This does not authorize bypassing the company gateway for any other capability. No Flayr/VidLingo runtime, Python runner, new dependency, chat-model replacement, editing or selling-point extraction is used.

An administrator configures `CLIPMENTOR_FUNASR_API_KEY` and `CLIPMENTOR_FUNASR_ENDPOINT` through the existing server environment/private profile keystore. The endpoint must be the workspace-specific Singapore HTTPS multimodal-generation URL. The model is fixed to `fun-asr-flash-2026-06-15`. Do not put credentials in a project, browser storage, fixture, log or source file. `GET /api/keys` exposes credential presence only. The current keystore uses a private local configuration file, not an authenticated multi-user secrets system. A future shared deployment keeps this configuration on the company server; distributing a desktop app alone does not provision it. Initial local provisioning reused the previously authorized credential once; subsequent runtime calls never inspect another repository or its Keychain item.

The existing shared plugin assembly registers `POST /api/clipmentor/transcribe-source` for development and the Electron server. It uses the existing loopback/Origin authorization, accepts only a managed original upload, hashes actual source bytes and verifies the known master hash. If that hash is absent, matching declared original byte size is required before recording the computed hash. Known derivative names and hash mismatches are rejected, not relabeled as the original. Automatic proxy-to-master relinking is not implemented.

Load the bundled `clipmentor` skill and call `transcribe_clipmentor_source` with:

- `assetId`: exact original video asset ID; no timeline placement required.
- `operationId`: stable UUID v4 for the authorized operation; retain it after failures.
- `maxRequests`: explicitly authorized cap on external chunk requests, including failures. There are no automatic retries.
- `language`: `auto` by default, or the actual supplied ISO language; never infer Malay merely from the market.
- `expectedRevision: 0`, `actor` and `reason`: a fresh analysis only; existing records are not overwritten.

The internal route receives `src`, optional `expectedSourceHash`/`sourceSize`, `operationId`, `language` and `maxRequests`. Credentials and endpoint are never caller-supplied. Results use `SourceTranscription` in `shared/clipmentor-asr.ts`; the client validates before applying a reversible ProjectDoc update. `read_clipmentor_analysis` returns the persisted draft. A changed project or changed source prevents application; the server operation record remains available for recovery, without authorizing another paid request.

Audio is always MP3, 16 kHz, mono, 64 kbit/s. Source ranges are at most 240 seconds with 2 seconds overlap. Actual encoded bytes must be <=8,000,000; larger chunks subdivide before any external call. The planned chunk count must fit the explicit budget. Each chunk retains its offset, byte count, audio hash, original timed words, status, HTTP status when available, provider request ID and skipped whitespace-separator count. Only exact overlap text matches are deduplicated; disputed overlap words stay in both chunk records and are omitted from the canonical transcript with a conflict record requiring review. This does not guarantee perfect acoustic alignment at a seam.

Durable operation records live under the active profile's `clipmentor-asr` directory. Atomic reservations count a request **before** network I/O. Reusing the same operation ID returns its stored completed/failed result without a call; an interrupted/reserved outcome is refused, never silently replayed. Partial failures stop subsequent chunks. HTTP bodies and upstream exception messages are not logged or exposed; failure stages are recorded as network/http/json/timestamps. Operation files contain transcript data and need normal company storage protection; they do not contain credentials or audio base64. Temporary encoded audio is removed after the operation.

Only `clipMentorAnalysis` and, when missing, its asset's computed source hash are written. Timeline items, captions, original asset transcripts and sounds are untouched. Product name is explicitly pending; points, evidence, blueprint and reviews are empty. Actual ASR metadata is optional on older analysis schema-v1 records, so historical imports remain readable. Every transcript remains machine-generated and not listening-verified. Failed/partial runs, overlap conflicts and out-of-range provider timestamps are retained and surfaced; no auto-clamping or approvals. A complete ASR response does not mean complete analysis or film acceptance.

```bash
npm run verify:clipmentor-asr
npm run verify:clipmentor-analysis
npm run verify:server-tool-catalog
```

The ASR verifier uses only mock calls and synthetic media; it covers 601-second sources, byte subdivision, offsets, overlap conflicts, failures, request limits/no replay, key redaction, route authorization, stale project writes, missing source hashes and storage/version/both transfer formats. It does not spend API credits.

The authorized Teashell live test used exactly two requests: the first failed, the second succeeded with 343 words versus 362 historical words. A historical raw-response replay exposed whitespace entries rejected by the first parser; the regression test was run failing then passing, and the fixed parser exactly reproduces all 362 historical words and times. The first live raw response was not retained, so its sole cause is not independently proven. Real-output consistency is **not accepted yet**: 71 word edits against unverified history, plus differing audio preparation, require listening review. No more calls are authorized. The final provider word exceeds source duration by ~3.33 ms and remains flagged. Built-in Agent English status replies despite Chinese instructions also remain unresolved. The parent workspace's live-run record contains the evidence.

Offline follow-up classified 26 text-difference blocks; only one has identical characters with different token boundaries. The previous maximum 1.596-second delta paired two occurrences of `aku` with disjoint source intervals; it is not a verified audio offset. Both transcripts remain unchanged. Critical interpretation/CTA wording still needs listening review; no audio-perception tool is available in the current operator session. Five source-quality PCM clips and side-by-side contexts were prepared without recognition calls. No new visual-observation or selling-point extraction path has been approved as ready by this review.

## Historical data first slice

Project-owned historical analysis storage, not an autonomous video analyst. No new ASR/vision/TTS calls, UI, Flayr imports, rendering changes or video editing. The optional `ProjectDoc.clipMentorAnalysis` field follows the existing V3 optional-field convention and has its own schema version 1. Malformed analysis rejects project migration rather than silently dropping the record; ordinary projects are unchanged.

## What is portable

`fixtures/teashell-historical.json` contains source evidence/frames, two blueprint-intent units and historical machine transcripts (362 full-source words plus the separately transcribed ending). It is derived from the approved development files, with local filesystem paths replaced by basenames. It has no audio/video bytes, credentials, executable Flayr code, or runtime dependency on another repository. It preserves original IDs/statuses, including `uncertain`; historical model-call results remain unknown. Added visible-action/interpretation records have stable IDs based on existing point IDs. No historical approvals are fabricated.

The source hash is `be72d6c5ce77f168738e689d1db442487e39b81a437a44aab467c6282c1b2af0`. The saved production project asset ID was `12546aa7-70fd-42c1-852a-8bf50f2abf58`; always read the current project/asset instead of assuming that ID exists in a new project.

The historical ASR endpoint is 99.870s, slightly beyond the 99.866667s source duration. Import preserves those words/times; handoff reports `source_time_out_of_bounds`. No automatic truncation is performed. A positive review test explicitly corrects only its disposable test copy. Importing the real data does not mean it is ready for synthesis.

## Use with the built-in Agent

Load the bundled `clipmentor` skill (or discover the following tools with ToolSearch). Tools operate on the current project through the existing reversible draft/ProjectDoc command path. No new server routes or environment variables are needed.

1. `read_clipmentor_analysis {}` returns `analysis`, current `revision`, and `handoff`.
2. `revise_clipmentor_analysis` with `action:"import"`, `expectedRevision:0`, the current `assetId`, and `fixture:"teashell_historical_v1"` imports the bundled two-unit development record without passing its large JSON through the model. Alternatively use `input` equal to the **JSON contents** of a historical pack; do not supply both. Do not pass a local path. The tool checks the current asset's source hash and refuses to replace an existing analysis.
3. For a record correction, call `revise_clipmentor_analysis` with `action:"revise"`, the current `expectedRevision`, `collection` (`evidence`, `points`, `blueprint`, or `transcripts`), `id`, and the complete replacement `record`. The ID cannot change. Source/evidence/blueprint edits invalidate affected confirmations, and the audit records the change. For a single transcript end-time correction, supply `collection:"transcripts"`, `id`, zero-based `wordIndex` and explicit `endSeconds` instead of `record`. Only that endpoint changes; the code validates bounds and never auto-clamps.
4. `review_clipmentor_analysis` takes `pointId`, `state:"confirmed"` or `"needs_revision"`, `expectedRevision`, `actor`, and `reason`. Confirmation requires source/reference/time checks to pass. Read again after every write to obtain the current revision.

Every write requires `reason` and the following actor fields:

```json
{
  "operator": "the locally declared operator",
  "executor": "the Agent or script performing the write",
  "instruction": "reference or quote of the actual operator request",
  "identity": "local_declared_not_authenticated"
}
```

Only record a confirmation when explicitly requested by the operator. This slice does **not** authenticate employees or verify that a model-supplied instruction quote is real; actor fields provide declared provenance, not identity security. The existing host draft/apply path still governs writes. There is no new human-login or trusted authorization subsystem. Code generates timestamps and content digests; the model cannot supply a digest to keep an obsolete confirmation valid.

All three tools are registered in the Agent catalog. Reads are read-only; writes are reversible project draft edits, not global persistent mutations. They do not change transcripts attached to timeline items or other editing data. Analysis transcript corrections affect only this analysis record.

## Read the result correctly

`handoff.scope` is always `pre_edit_analysis_only`. `ready_for_copy_review` means deterministic checks and locally declared point confirmations are current. It never means complete film acceptance, verified speech, verified efficacy, or autonomous analysis quality.

The checks cover evidence/point references, frame/source times, matching source hashes, and inclusion of confirmed required point IDs in blueprint units. They cannot discover an omitted selling point or judge whether the interpretation is insightful. Pending, stale or missing evidence returns `review_required` with issue IDs. Unknown historical visual calls are preserved and may be manually reviewed; they are not silently changed to successful calls.

Invalidation compares the analysis source hash against the same ProjectDoc's asset and each review digest against current point dependencies (including referenced transcript content and blueprint intent). Historical snapshots restore their own records. Cross-version source authority, proxies, precise PTS and rule-version invalidation are deliberately outside this slice. Asset renames and media URL rewrites do not affect hash-bound identity. Unsupported ID rewrites appear as missing references rather than silently selecting a different source.

## Verify

```bash
npm run verify:clipmentor-analysis
```

This machine’s missing `.bin` launchers were restored from installed package metadata without installing/upgrading packages; the npm command now passes. If another checkout has the same missing-shim issue, the existing package entry points can diagnose it:

```bash
node node_modules/tsx/dist/cli.mjs src/clipmentor/analysis.verify.ts
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit --incremental false
```

Tests use actual project migration/store/version/package paths and an in-memory local-media response for synthetic transfer bytes. No real network request is sent. They preserve and roundtrip the uncorrected historical records separately from the test-only positive-review copy. Runtime/browser Agent use and end-to-end new-video quality still require separate acceptance.


## 2026-10-16 live-run follow-up

The npm test command now works after restoring missing `node_modules/.bin` symlinks from the installed packages’ own `bin` metadata (no installation or version changes). Direct dependency inventory still reports missing `onnxruntime-node`; this is not a clean full-environment/build acceptance. Ordinary `npm run dev` also stops in the predev Whisper provisioning step because `cmake` is absent. For this non-ASR test the existing `node scripts/dev-profile.mjs --host 127.0.0.1 --port 5199 --strictPort` launcher was used after verifying the server tool catalog. No speech dependency was installed or called.

The first real run exposed an omitted generated server catalog update. `assets/agent/openchatcut-tool-schemas.json` is now regenerated, and the analysis verifier compares the three generated server input schemas against the current tools so this mismatch cannot silently pass the analysis test again.

A copied Teashell project was imported by the built-in Codex-backed Agent with the short fixture argument. It reported `review_required`, two ASR time-range issues and six pending points; it made no review confirmations. On the operator’s explicit endpoint-correction instruction it revised only FULL word 361 and END word 126 to 99.86666666666666s, with reason `取整误差，人工确认`, using revisions 1 then 2. That initial run ended at revision 3 with no point approvals. The original fixture and source project remain unchanged. This observed behavior is not a code-level guarantee against autonomous self-approval.

In a separately authorized follow-up on the same test copy, the built-in Agent confirmed only `TS-CMP-01` (revision 4), appended a test-only filming condition (revision 5, review became `stale`), then restored the exact original point through the revision tool (revision 6). The saved review and handoff point state remained `stale`; restoring matching content did not revive the old confirmation. No second review call occurred. Independent persisted-document and tool-trace checks verified that all other analysis content, timeline/media fields and the original project were unchanged. Overall handoff remained `review_required`, with the other five points pending. This closes the real confirmed-to-stale test for the development sample; it does not establish authenticated human approval or new-video analysis quality.

## Historical V1: copy-review regression and production gate (2026-10-19)

This is a runtime **copy + planned-picture** gate, not an audio/video acceptance result. Both `src/agent/tools.ts` (built-in/Codex/browser tools) and `server/external-agent/offline-executor.ts` (server data-only tools) call the same gate **before dispatching handlers**. Analysis/observation/transcription, approved source import, reads and follow-up questions remain possible. Production mutations, generation/reruns, generic scripts and render/export tools require review. Ordinary projects without ClipMentor analysis or creative mode retain their previous behavior. An analysis-bearing project cannot bypass this by switching creative mode off.

### Recorded V1 result: NOT qualified for automatic release

One fresh independent reviewer, with no conversation history, saw random case IDs, exact old narration/captions/Chinese meanings, source-action records and the E5 contact sheet. No revision numbers, author reasons/self-review or expected verdicts were supplied. It rejected revision90 but **passed revision95**. The raw verdict is preserved in `fixtures/copy-review-blind-20261019.json`; no second attempt or induced change was made. These are development regressions, not a representative quality benchmark or native-speaker/audio validation.

`legacyCopyReviewCalibration()` preserves the V1 comparison of those verdicts with the previously rejected cases. Because revision95 was missed, it returns `qualified:false`. Thus **even a fresh, structurally valid pass receipt cannot currently authorize ClipMentor production** (`copy_review_method_unqualified`). Do not change the expected result, replace the raw verdict with a lead review, or manually force this boolean true to make a release pass. Future qualification needs genuine independent validation, including suitable good examples and unseen cases; replacing the fixture is not itself evidence of improvement.

### Review binding and invalidation

`CopyProductionReview` is an optional, shape-validated `clipMentorAnalysis.production_copy_review`. `bindCopyProductionReview(doc, result)` is a **host handoff function, not a tool available to the author Agent**. Before the independent call, the host captures `copyReviewSubject(doc)` and retains its revision/digest with the review job. Binding requires those same values; an old response cannot be re-stamped onto a new draft. The SHA-256 covers analysis revision, protocol/calibration evidence, all currently selected script candidates and source identity. The receipt is separate from `self_review`, `lead_text_review`, point confirmations and old `production_allowed` text; none of those counts as this approval. Author and reviewer run IDs must differ. The host must supply genuinely independent run provenance; string IDs are not authenticated identities or proof of model quality. No new reviewer runner, UI, or production approval was created this round.

The first slice hashes all analysis content except the receipt itself. This is deliberately conservative: any analysis revision, narration/caption/Chinese/picture/source change or actual source hash change requires new review. Changes followed by restoration through the existing revision tool increment revision again; the old receipt stays stale. Saving/reopening unchanged data retains the receipt. Restoring an entire historical ProjectDoc restores that exact snapshot's review record; this gate is not an external revocation ledger across historical snapshots.

`checkCopyProduction` returns `allowed`, a distinguishable `code`, `scope:"copy_and_planned_picture_only"`, and **always** `complete_film_accepted:false`. Missing/malformed/failed/insufficient/stale/incomplete-scope receipts refuse production. Read `read_clipmentor_analysis.production_gate` for the live reason. A pass with a blocking/unknown finding is also refused. Voice submissions must exactly match a reviewed sentence or a full reviewed unit (whitespace may differ); legacy generation reruns cannot reuse unchecked text.

Current subject extraction reads `internal_review.current_script_candidate` and its `lines` (`id`, `narration_ms`, `caption_lines`, `zh`, `source_seconds`). Incomplete/unsupported candidate layouts fail closed rather than fabricating missing values. The check covers the selected candidate pack, not unselected future units or final timeline semantics. Manual editor controls, direct vendor/HTTP access and arbitrary local file edits are outside this **Agent-tool workflow gate**, not protected by a security boundary. Actual sound length, frame/caption alignment and final film review remain separate requirements.

### Verification

```bash
npm run verify:clipmentor-analysis                 # includes the mechanical gate tests
npm run verify:clipmentor-production-gate
npm run verify:clipmentor-copy-review-regression   # currently exits 1: revision95 was missed
```

The mechanical suite invokes both real dispatchers against disposable in-memory projects. Missing, failed, insufficient, stale, self-approved and unqualified states do not reach TTS/editing handlers; there are zero network calls or timeline mutations. It also revises and restores a candidate through the real analysis tool and confirms that the old receipt remains stale. Ordinary-project edits are positive controls. A **synthetic** qualified calibration exercises only the pure policy's pass branch; it is never injected into runtime dispatch and must not be reported as real reviewer qualification.

Red/green was observed: before adding the dispatch guards, the new test failed on `set_aspect_ratio` with no production-gate response (exit1). After the guards, the same suite passes. Separate blind-regression validation intentionally remains red; mechanical gate correctness does not imply semantic-review quality. No production project, narration, media or timeline was changed and no TTS was invoked. App TypeScript checking passes; desktop checking is still blocked by the existing missing `onnxruntime-node` dependency.

### Continuous source video observation

`observe_clipmentor_source_video({operationId, maxRequests:1, expectedRevision})` calls the local-editor `POST /api/clipmentor/observe-video`. Server-only `ROOTIFY_GATEWAY_API_KEY` is used with the existing company native Gemini 3.8 endpoint, HTTP/1.1, 600s timeout, no retry/redirect, bounded inline MP4 (100MB JSON maximum). The source must have an audio stream and match the stored SHA256. No audio stripping, transcoding or implicit segmenting occurs. Current selected lines/plans/ranges are host-built; historical observations and self-review are excluded.

Typed window and line findings, raw public response, requested/returned model, revision/digest, input/request hashes and attempt count are retained in the active private runtime profile `clipmentor-source-video/<operationId>.json`. A completed identical operation returns cache; pending/failed/different inputs refuse replay. The tool does not mutate the project or bind any approval. A source-capacity finding is not an actual edited handoff or complete-film pass. Run `npm run verify:clipmentor-source-video` without credentials for mock verification.

`read_clipmentor_source_video({operationId})` reads the project-bound saved receipt without a credential, provider call, replay or project change. The same same-origin endpoint accepts `{action:"read_receipt",operationId,projectId}`. It reports current/stale binding, precise local validation issues and upstream HTTP status separately. Original raw responses remain private in the runtime directory. Local validation failure is HTTP422, upstream/transport failure HTTP502, input/binding error HTTP400.

Estimated observation times may differ from window boundaries by at most 0.010s; the original float is preserved and a notice includes window ID, field, bounds and delta_ms. Wrong IDs, missing evidence, reverse/non-overlapping intervals and larger offsets remain errors. These are structural checks only. `recoverSourceVideoReceipt` is an explicit offline operation: verify the unchanged source hash, frozen request hash, subject and operation fingerprint against the retained reservation and failed ledger, then save a `.revalidated.json` sibling without overwriting the original or calling `post`. Readback checks the sibling's original-record hash and project binding. It does not change prior semantic results or grant production permission.
