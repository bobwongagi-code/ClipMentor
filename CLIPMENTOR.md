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
