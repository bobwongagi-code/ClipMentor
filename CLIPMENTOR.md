# ClipMentor modified version

Modification notice: 2026-10-06; updated 2026-10-26.

This repository is a modified version of [OpenChatCut](https://github.com/0xsline/OpenChatCut), by 0xsline and its contributors. ClipMentor is not an official upstream OpenChatCut release. Original author metadata, license notices and upstream commit history are retained. No claim is made that ClipMentor owns the upstream code or branding.

## License and attribution

The application remains under GNU AGPL-3.0, as specified in the upstream package manifest and [LICENSE](LICENSE). ClipMentor additions in this repository are provided under that same license. Retain existing copyright, license, font and bundled-skill notices, including [font licenses](assets/fonts/LICENSES.md) and [skill notices](src/agent/skills/NOTICE.md). Third-party components retain their own applicable licenses; this notice does not relicense them.

Private repository visibility is an access-control choice, not a license exception. Before distributing this modified application or offering it as a network service, review the applicable AGPL obligations and provide corresponding source where required. In particular, section 13 concerns users interacting with a modified version over a network; a private repository alone is not a source-access offer to those users. This repository has not been deployed as a company service by this work.

## Changes recorded on 2026-10-06

Application commit `4110215` includes:

- ClipMentor bundled skill, planning reference, catalog entry, catalog mirrors and regression checks.
- Per-request Codex token accounting and actual tool-catalog budget diagnostics.
- H.264 PCM-to-AAC finalization and a regression test for audio alignment.
- Synchronous export documentation, to distinguish downloads from asynchronous render jobs.
- Visibility of approval proposals in an otherwise empty chat panel.

Existing editor, media, model-provider and export implementations remain based on OpenChatCut. The parent production workspace, business footage, synthesized voice files, credentials and local project data are not included here.

## Verification limitation recorded on 2026-10-06

Targeted skill, Codex, tool-catalog and H.264 audio checks passed before the application commit. A full TypeScript build was blocked by an incomplete local installation of the already-declared `onnxruntime-node@1.22.0`: its local directory lacks package metadata and JavaScript/type files. This does not establish a source-code defect. Dependency versions and the lockfile were not changed to bypass the failure. A complete clean-install build remains to be verified; this repository upload is not a release-readiness claim.

## Changes recorded on 2026-10-24

- Current copy, picture plans and source evidence are bound to independent teaching reviews and production checks. Missing evidence, stale approvals and conflicting timeline observations cannot be treated as passes.
- Candidate preparation can be saved independently of a later review failure, recovered after reopening and followed by normal asset saves. Rejected preparation is not replayed as success, and rejected tool mutations are rolled back in the executor draft.
- Bounded local preview editing uses the application's existing media roots and references, supports safe Unicode filenames and retains one-attempt authorization. Unknown request outcomes remain distinct from zero new requests during receipt reads.
- Transition candidates and delivery differences are derived from existing project/timeline data. These mechanical checks do not prove semantic teaching quality or continuous viewing acceptance.
- Scene detection handles zero selected frames without an empty encoder failure. Regression coverage also checks current workflow cards, credential privacy and MCP notification subscription readiness.

The earlier incomplete local ONNX Runtime installation was restored to the exact lockfile-pinned package without changing dependency versions. The Node TypeScript project now includes the existing desktop API declaration rather than adding substitute types. This is a source update, not an installer release or a claim that a new video has passed editorial acceptance.

Verification on 2026-10-24 used Node 24 and an isolated checkout containing the intended changes without unrelated worktree edits. Full `npm test` (pretest, 165 main test segments and posttest), lint, the TypeScript/frontend build and targeted ClipMentor/server-run regressions passed. The frontend build skipped native Whisper provisioning; a fresh dependency installation, native installer build and real editorial acceptance were not performed. Existing lint/build warnings remain.

## Source checkpoint on 2026-10-26

This checkpoint retains existing preparation work for server-owned editing, API copy review and staged production tasks. It is not a release, a migration of the current browser workflow, or evidence that autonomous video production is reliable. The new-sample capability test remains separate and has not started. No personal model credentials, production projects or media are included.

Server-only frame extraction is excluded from browser tool discovery and requires an internal execution host. Teaching-unit preview reviews use saved output placement ranges; legacy transition reviews retain their computed candidate ranges and cannot override them. Source-observation receipt recovery reuses the original completed result or returns the saved failure, without resubmission. Regression tests run through the existing production and preview-review verification commands. Native Whisper provisioning still requires CMake or a prebuilt Whisper binary; a frontend-only build is not a successful native provisioning check.


Execution consistency uses the existing editor commands and atomic batch: browser and server `edit_item` share replacement ordering, final native-picture preservation and cancellation checks; unsupported browser effects remain unavailable on the server. Server mutations are serialized per editor and commit under the existing ownership/revision fence. Successful mutations return `saved`, `projectId` and `projectRevision` only after commit; dry runs and rejected edits do not claim persistence. The actual offline store also enforces native-picture preservation, including writes made by other tools.

Server-host tool requests and outcomes use the existing run ledger. Small receipts retain their metadata; large receipts use the existing artifact archive and `read_agent_artifact` pagination. Credentials and image payloads are excluded from persisted receipts. An exception or interruption after dispatch remains outcome-unknown: inspect the saved project or original operation instead of automatically repeating a mutation. Export jobs retain their original project revision and timeline before media materialization; cached or recovered jobs must match that binding. Legacy jobs without a verifiable binding remain readable but cannot be promoted to a newly bound production result. Duplicate export submissions retain the original cancellation controller. The production worker releases edit ownership after enqueueing the immutable export, then polls the original job; export failure does not discard committed edits. These are execution contracts, not semantic or final-film approval.

Ordinary clip-update locators (`itemId`, `id`, `targetItemId`, and selected-clip references) use the same host-independent normalization. Exact IDs take priority over prefixes; ambiguous prefixes cannot pick an arbitrary clip. Real server effects remain unsupported. Both tool-request event types share the existing 512 KiB UTF-8 budget for admission and durable projection; other event types retain the 64 KiB limit. The execution-admission regression covers valid/invalid locators, atomic rollback, boundary/overflow rejection and cold read of large requests; these checks do not approve content or expand tool permissions.



Internal blueprint review boards use the original saved analysis and local media. The human view includes source-speech Chinese, label translations and both explicitly bound creator endings; conflicts refuse generation rather than mixing revisions. Achievement-opening guidance remains optional and evidence-bound, not a fixed approved sentence. See [usage and boundaries](docs/clipmentor-blueprint-review.md). No production project, review verdict or media is updated by generating a board.
