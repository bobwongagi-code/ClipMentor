---
name: verification
description: Use when checking whether agent edits are reflected in the OpenChatCut project and editor.
---

# Verification

Choose evidence for the requested object, not an unexplained pass level:

| Check object | Required evidence |
|---|---|
| Code or tool contract | Focused local tests, type checks and applicable build; include failure cases and actual runtime entry where behavior changes. |
| Editor behavior | Exercise the affected editor/tool path, then read saved structure and inspect actual composed output. An authorized real Agent run adds behavioral evidence; a mock or direct-tool test is not that run. |
| Packaged desktop behavior | Exercise the packaged app when packaging or desktop-only behavior is the subject. A development page does not prove installed-app behavior. |

Older engineering records may call these L0/L1/L2. ClipMentor’s teaching L1/L2 means selected-point coverage/unit continuity, not editor or desktop testing. In a report name the object and method instead of saying only “L1 passed”.

Record results in the existing task/check record as **automated verification**, **AI assessment**, **human confirmation** or **unverified**, each with the output version, evidence and covered scope. These may coexist: extracted frames or a code test do not imply human listening, continuous viewing or teaching approval. Recheck the affected evidence after its bound output changes; reuse unchanged valid evidence.

Local mocks and saved artifacts are appropriate for deterministic checks. This skill does not authorize another model call, ASR, synthesis, production render or human approval step. If the required real scenario exceeds the task’s authorization, record it as unverified; do not downgrade the agreed method or spend a new call to make the report green.

Prefer two signals:

1. `read_project` for structure: assets, tracks, items, frame placement, timeline duration.
2. A visual capture path for rendered evidence at exact frames.

Use `view_timeline_frames` for composed timeline proof. This verifies the edited OpenChatCut timeline: trims, layers, captions, effects,
markers, placeholders, crops, transitions, and layout.

For raw source-asset frame inspection, choose the cheapest path based on where
the bytes live:

- The agent in this build has no local filesystem access; all source bytes live
  in the project media store (`/media/uploads/`). Use `view_asset_frames` with
  the project asset id — the server takes an ffmpeg contact-sheet fast path
  automatically, so it is already the cheapest source-frame route.
- `view_timeline_frames` renders the composed timeline (the editor-truth check);
  `view_asset_frames` samples raw source frames. Pick by what you are verifying.
- There is no separate `get_contact_sheet` tool in this build — the contact
  sheet is what `view_asset_frames` / `view_timeline_frames` already return.

Use local/remote source-frame artifacts only for source understanding, moment
selection, and rough trim decisions, not as edited output or timeline proof.

For local-only or upload-in-progress media, composed timeline proof may be
blocked until the asset has bytes available to the renderer. Source-frame
inspection via `view_asset_frames` still works as long as the asset's bytes are
on disk (`/media/uploads/`).

If a visual proof path is blocked, inspect its saved failure and repair the local preparation or use an existing valid artifact within the task’s scope. If evidence still cannot be obtained, report the specific unverified result. Do not turn a technical diagnostic into a business-user choice or silently replace a required representative video with still frames.

Useful checks:

- After import: `read_project({ "view": "assets", "assetId": "<prefix>" })`
- After move/trim: `read_project({ "view": "timeline" })`
- After visual overlay or MG on any timeline media: `view_timeline_frames({ "frames": [30, 45, 75] })`, then look at the returned frames.
- For user-requested source selection or visual moment picking: sample stills with `view_asset_frames` and inspect them. Use that only to choose source files, moments, and rough trims. Build the visible edit as OpenChatCut timeline items. Do not treat raw source inspection as timeline verification or as permission to produce the edited video elsewhere.
- For source-frame inspection: call `view_asset_frames({"assetId":"...","sourceTimesMs":[...]})` after `read_project({"view":"assets"})` confirms the asset id/type. Prefer this over asking the user to reattach the file.
- For disk-backed media, the local renderer can read `/media/uploads/`; wait for upload completion when bytes are still a placeholder. Only a genuinely remote execution path requires remotely accessible media.
- For no-source validation: confirm the tool manifest exposed the parameters you used, then record the visible proof in the trace log.

When talking about seconds, verify the fps from `read_project` or use adapter tools that resolve fps internally.

When reporting a timeline item location, use only the latest `read_project` structure for track alias, item id, start, duration, and asset id. Do not report planned/default tracks or tool-call intent as verified placement.

Do not treat a command-line JSON response alone as sufficient when the user asks whether the editor reflects the result. Use the editor URL or visual proof when practical.

## Real Agent transcript check

When a real Agent/editor scenario has been run, inspect the complete chat record before reporting success:

1. Read the final assistant response and every tool row created by the run.
2. Expand failed or warning rows and record the exact error.
3. Check for aborted turns, repeated retries, stale proposals, incomplete jobs,
   and tool results that the final response incorrectly describes as successful.
4. Compare the latest `read_project` result with the visible timeline.
5. For visual edits, inspect returned timeline frames rather than trusting the
   assistant summary.

A run with a correct-looking timeline but an unreported tool error is not a
clean pass. Fix the cause or report the remaining error explicitly.

If verification fails, classify the gap before changing tools:

- tool description or schema was insufficient
- skill instructions were missing a step
- `read_project` did not expose enough state
- editor authorization did not complete
- media/transcription pipeline failed
- local/remote renderer or editor observation was blocked
