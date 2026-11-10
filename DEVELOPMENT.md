# ClipMentor Development

[English overview](README.md) · [中文介绍](README_ZH.md)

## Repository and Requirements

This is the ClipMentor fork of OpenChatCut. Use **Node.js 24.x** and npm, matching [package.json](package.json) and [.nvmrc](.nvmrc). Source and configuration locations are indexed in [config/README.md](config/README.md).

```bash
git clone https://github.com/bobwongagi-code/ClipMentor.git
cd ClipMentor
npm ci
cp .env.example .env.local
npm run dev:isolated
```

The isolated web-development entry avoids the desktop Whisper preparation hook. Open the local address printed by the terminal; Vite defaults to port 5199. Service credentials are optional until a task needs that service. Configure only the required providers using [.env.example](.env.example), and do not put credentials into project files or Git.

Existing package names, storage paths and environment variables still use `openchatcut` and `OPENCHATCUT_*`. Keep these names for compatibility with saved projects. Development profiles are isolated per checkout by default; `npm run dev:shared` intentionally uses the legacy shared development store.

## Web and Desktop Preparation

The development launcher selects the profile and executes the child from the same source checkout, even when invoked from another directory. Its startup record shows the checkout, parent commit and clean/dirty state. A dirty checkout is not an exact committed version; use the reviewed source rather than manually maintaining a second active copy.

At this source revision, the `predev` and `prebuild` scripts include `sync:whisper-cli`. Therefore `npm run dev` and `npm run build` may download or prepare the desktop transcription runtime. The `dev:isolated` and `dev:shared` entries do not have that Whisper hook. Check the scripts in the revision you are running rather than assuming every web command has identical preparation.

Desktop development and packaging use the existing Electron and Whisper preparation paths. On macOS, source preparation can require CMake and a compiler toolchain. A prebuilt CLI supplied through `OPENCHATCUT_WHISPER_CLI` must match the target OS, architecture and required adjacent libraries.

Cloud transcription, review and voice services are separate configurations. A successful web build does not establish native offline transcription, installer readiness or successful video production.

## Planning and Review

- [Bundled workflow](src/agent/skills/clipmentor/SKILL.md): task selection, planning, execution and review responsibilities.
- [Planning and teaching units](src/agent/skills/clipmentor/references/planning.md): product reasoning, source playback, explanation windows and picture tasks.
- [Delivery checklist](src/agent/skills/clipmentor/references/delivery-checklist.md): actual deliverable checks.
- [Review boundaries](src/agent/skills/clipmentor/references/review-boundaries.md): content approval, measured audio/picture fit and final acceptance.
- [Analysis contracts](src/clipmentor/README.md): engineering interfaces and dated implementation records.

Keep original playback, evidence samples and explanation ranges distinct. Review results bind to the current source and manuscript; a saved historical approval cannot authorize changed content. Code checks and frame sampling do not replace watching and listening to the finished video.

Task records should identify the planner, executor, source, output scope, preserved content and permitted budget. Use configured services only within the task's authorization. Do not make paid analysis, voice, review or rendering requests to validate a documentation-only change.

## Verification

```bash
npm test
npm run lint
npm run build

# Focused ClipMentor checks
npm run verify:clipmentor-blueprint
npm run verify:clipmentor-production
npm run verify:clipmentor-preview-review
```

Read the preparation notes above before running the build. These commands verify code and contracts; they do not approve a particular lesson, certify native-language quality or demonstrate reliable autonomous production.

## 外部调用的等待与结果恢复

Use the existing governed call records rather than resubmitting an uncertain operation. `server/clipmentor/external-call.ts` defines request classes/deadlines and persists identity, raw responses and parsed results below the active `runtimeProfile().rootDir`; ASR, source observation and copy review keep their task records in their corresponding `clipmentor-*` subdirectories. Read the recorded `deadline_at`, status and failure class; elapsed waiting alone does not prove non-delivery.

`npm run report:clipmentor-calls -- [runtime-directory]` is the existing read-only, zero-network summary. It diagnoses governed calls; it does not recover a transcript or approve output. Source observations have `read_clipmentor_source_video`; previews use the existing review tool's read action. ASR uses `read_clipmentor_analysis(view="source_asr", assetId, operationId)`, including before analysis exists. The existing authenticated HTTP endpoint accepts explicit `action:"read"`; it never falls through to submission, reserves an operation, imports text or grants approval. Current source bytes and saved project/request identity must match. Legacy records without that identity remain unverifiable; pending/missing/stale/malformed records are not permission to resubmit. Only a bound saved result can use local raw-response recovery, preserving original records and consumed attempts. Do not call the submission action as a status probe.

Unknown outcomes require result lookup; local parsing/format failures require local repair; configuration errors require configuration repair. Recovery preserves input identity, original judgments and consumed attempts. Confirmed zero-submission preparation recovery is distinct from a provider resubmission; a new provider request requires the current task's applicable authorization. Keep credentials/raw diagnostics internal.

## Related Projects

- **Flayr** develops product-to-content reasoning, shooting directions, proposed new scripts and feedback on creator submissions.
- **ClipMentor** produces explained reference videos, source storyboards and editable lessons.
- **Business and operations tools** supply product/cooperation context, data signals and communication decisions.

Exchange files, source times and versions without treating shared context as approval to send messages or process unrelated media. ClipMentor can take a direct task; it does not require a Flayr run.

## Editor Foundation and Data

ClipMentor inherits OpenChatCut's multitrack timeline, media tools, Agent integration, preview and export foundations. External-agent integration is documented in the shipped [editor skill](skills/openchatcut/SKILL.md). Existing MCP and runtime names remain compatible with upstream; this documentation does not rename them.

Local project storage and server-side credentials do not make connected model/media services offline. Internal source videos, production projects, local credentials and private runtime receipts do not belong in documentation examples.

## Attribution

See [CLIPMENTOR.md](CLIPMENTOR.md), [LICENSE](LICENSE), [Agent Skills notices](src/agent/skills/NOTICE.md) and [font licenses](assets/fonts/LICENSES.md). Upstream documentation and installers belong to [OpenChatCut](https://github.com/0xsline/OpenChatCut), not this fork.

For repository history, see [CHANGELOG.md](CHANGELOG.md). Documentation changes do not constitute an application release, installer publication or deployment.
