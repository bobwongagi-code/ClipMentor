# ClipMentor modified version

Modification notice: 2026-10-06.

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

## Current verification limitation

Targeted skill, Codex, tool-catalog and H.264 audio checks passed before the application commit. A full TypeScript build was blocked by an incomplete local installation of the already-declared `onnxruntime-node@1.22.0`: its local directory lacks package metadata and JavaScript/type files. This does not establish a source-code defect. Dependency versions and the lockfile were not changed to bypass the failure. A complete clean-install build remains to be verified; this repository upload is not a release-readiness claim.
