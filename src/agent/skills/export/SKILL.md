---
name: export
description: Use when a OpenChatCut video editing or creation workflow needs export, render, download, share, final delivery, subtitle-file export, render choice, local-only asset handling, or export fallback explanation.
---

# Export

Use OpenChatCut's export tools for delivery. Reuse a saved export or active render bound to the same saved timeline revision, range and export options before submitting. `submit_export` can finish in-call; `submit_render_job` returns an asynchronous job. Use `track_export` only for an actual returned or saved async job, not merely because a synchronous path is absent. Export is technical completion, not film acceptance.

Default policy:

- Prefer `submit_export` when the user asks to export/share/finalize the OpenChatCut timeline.
- Keep disk-backed originals local; this build renders from `/media/uploads/`. A remote connector may need an authorized accessible source, but do not upload solely because a file is local.
- Do not wrap sandbox `ffmpeg` work as a OpenChatCut tool. Use sandbox `ffmpeg` for full video processing only when the user explicitly asks for a standalone local-file operation outside a OpenChatCut editing workflow. For OpenChatCut editing tasks, do not produce a pre-edited or flattened local render as the primary review/final deliverable; use OpenChatCut export.

## Durable Export

Use `submit_export` for the execution path:

```json
{
  "format": "video",
  "codec": "h264",
  "resolution": "1080p",
  "fps": 30,
  "name": "final-cut"
}
```

Video codec options are `h264` (MP4, default) and `vp8` (WebM). Video frame-rate options match the editor UI: `24`, `25`, `30`, `50`, or `60`; omit `fps` to match the timeline. Audio export is MP3: pass `"format":"audio"` and omit `codec` / `fps` unless you explicitly pass `"codec":"mp3"`.

Follow the actual return shape. `submit_export` is the synchronous export tool: it can finish immediately and trigger a browser download, returning file name, dimensions, duration and size without a `renderId` or `downloadUrl`. A successful synchronous result is not an asynchronous queue job. Do not call `track_export` merely because a path is absent, and do not export again to obtain a queue entry. Report the returned file name and explicitly state when its local download path is unavailable to the tool.

`submit_render_job` is the asynchronous alternative and returns a durable `renderId`; use `track_export` only for that returned job, or a genuinely recorded asynchronous export. `read_export_history` may legitimately be empty after a synchronous browser download; an empty queue does not prove that export failed.

After getting each `downloadUrl`, expose the existing guarded download link through the current product UI. When the host has download/filesystem access and a local file is requested:

- Resolve the user's Downloads folder: `~/Downloads` on macOS/Linux, or `%USERPROFILE%\Downloads` on Windows.
- Before triggering any agent/browser download, check the Downloads folder for fresh Chrome download artifacts from the last few minutes that match the expected export name, extension, or render/download URL basename. Include both completed files and in-progress `.crdownload` files.
- If a matching fresh `.crdownload` exists, do not trigger another download. Wait until Chrome removes the `.crdownload` suffix and the final file size stops changing, then use that completed file.
- If a matching fresh completed file already exists, use it directly instead of downloading again.
- If only older files exist, treat them as collisions, not as the current export.
- Do not overwrite an existing file; choose a safe numbered filename such as `name (1).mp4` when needed.
- Always download the finished export file into the Downloads folder, not a temp/workspace directory.
- Show each requested video preview through the supported product/chat surface. If the host cannot inspect Downloads, report the returned download link/name without claiming a local file was opened.

Disk-backed local assets are renderable without cloud mirroring or a separate CLI path. If bytes are still uploading, wait for the existing upload; if bytes are missing, use the recovery steps below.

Report the returned `renderId` when present. The job is also visible in the editor's top-right export queue, including progress and cancellation. Use `saveToMediaPool:true` when the user asks to retain the result in My Media or when the active workflow explicitly defaults to automatic materialization, such as `livestream-to-clips`; otherwise the default remains a normal downloadable export. For long videos, call `track_export` once with `action:"wait"` and `timeoutSeconds:20`. If it returns `waitExpired:true`, keep its renderId and report the existing render as running, not failed. In an autonomous production task, let its saved continuation resume status reads; do not pause for a business-user retry choice. In an interactive session, the user may leave and later check the same job with `action:"status"`. Do not start another export for the same timeline while this render is active.

Use `track_export` when the user asks about export/render status, or when the current turn genuinely needs to wait for a submitted video/audio render. Completed connector exports return `downloadUrl`; for every completed entry, download the file to Downloads using the collision-safe rules above and show it inline in chat:

```json
{
  "action": "status",
  "renderIds": "abc123"
}
```

For the latest project export, omit `renderIds` and pass `"latest": true`. `track_progress` is for generation/transcription/upload jobs, not render jobs.

For NLE XML, use `submit_export` with `format:"xml"`:

```json
{
  "format": "xml",
  "nleFormat": "fcp_xml_resolve",
  "timelineId": "abc123"
}
```

`nleFormat` values are `fcp_xml` for Premiere XML (default) and `fcp_xml_resolve` for DaVinci Resolve XML. Omit `timelineId` for the active timeline, or pass a timeline id/prefix for a non-active timeline. Read and report warnings: captions, solids, SVG, unsupported clip attributes, and unrendered motion graphics may be dropped by the XML format. Motion graphics are only represented in XML when a transparent-ProRes MG export flow supplies `motionGraphicRenderKeys`; otherwise the exporter reports them as dropped.

For media-pool source download, use `request_asset_download` on a file-backed source asset. It returns a guarded backend download URL/path for the original source media. Do not use `pull_asset` for user downloads; `pull_asset` is sandbox-only.

For subtitle files, use `submit_export` with `format:"subtitles"`:

```json
{
  "format": "subtitles",
  "subtitleFormat": "srt"
}
```

Formats are `srt` and `txt`. The export uses the captions item's actual timeline word timing, source scope, translation variants, display-text overrides, and pacing fields such as `wordsPerPage` / `maxCharactersPerLine`, and creates a durable downloadable export job. It is appropriate for downloadable subtitle files. It does not yet reuse the browser Remotion caption page planner, so visual line wrapping/page breaks are timing-correct but approximate rather than byte-identical to burned-in caption pagination. For non-active timelines, pass `timelineId` from `manage_timelines` or `read_project`.

For one motion graphic as transparent ProRes 4444, use `export_motion_graphic_prores`:

```json
{
  "itemId": "abc123",
  "filenameMode": "asset"
}
```

Prefer `itemId` when exporting a specific timeline instance, because the item carries live `propertyOverrides` such as edited text. Use `assetId` for a media-pool motion graphic; the backend will use the first timeline instance for that asset when present, matching the editor's media-pool export behavior. For several motion graphics, pass `itemIds` or `assetIds` in one call. Each motion graphic still becomes a separate durable render; use `track_export` with the returned `renderIds` to wait, then download through each returned render download path.

When preparing XML that should reference rendered motion graphics, pass `"filenameMode":"xml"` and the same `timelineId` to `export_motion_graphic_prores`, then keep the returned `motionGraphicRenderKey` / `motionGraphicRenderKeys`; after the render completes, pass those keys and the same `timelineId` in `submit_export.motionGraphicRenderKeys` with `format:"xml"`.

## Local Render (this build)

All rendering is local: `submit_export` / `submit_render_job` drive the local render service (headless Chrome over the same timeline state the editor shows), reading media straight from `/media/uploads/` on disk. There is no S3 requirement, no CLI, and no cloud job to wait on for disk-backed assets.

- `submit_export`: subtitles/XML return synchronously; video/audio also render in-call in this build (long timelines can take a while — warn the user instead of polling).
- `submit_render_job` + `track_export`: the async route — returns a `renderId` immediately, poll with `track_export` (`renderIds` / `latest` / `onlyActive`), then hand the user the returned download path.
- Assets still on `blob:` placeholders (upload in flight) are not renderable yet — wait for `track_progress` target=upload to report ready before submitting.

## Fallbacks

If a render fails because an asset's bytes are missing (placeholder never relinked, file deleted from disk):

1. Read the saved render/error and exact missing asset binding. Check whether its original local bytes, pending upload or authorized original URL can be recovered through the existing import/relink tools; do not start another render to diagnose missing input.
2. Restore that asset identity and verify bytes before considering a new render. Reuse any completed render; an unknown result is not a confirmed failure or permission to resubmit. Preserve production budgets.
3. Request material only if the original source cannot be recovered. Do not ask business users to choose a renderer, provider or retry strategy.

Do not tell the user they need to understand HTML-in-Canvas, Remotion, or storage internals unless debugging. Explain at product level:

- "本地快速导出"
- "素材还在上传，稍等再导"
- "需要先重新链接本地素材"

## Result Trace

Record the actual returned file name, current timeline/range, dimensions/codec/fps and usable delivery link/path. Include `renderId` and queue status only when an async job exists. Preserve source/output identity and any local recovery performed. A successful tool response or file path does not prove readability, continuous viewing, Malay suitability or final user acceptance; record those checks separately under the active workflow.
