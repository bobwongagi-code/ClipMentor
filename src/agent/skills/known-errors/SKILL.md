---
name: known-errors
description: Use when a OpenChatCut tool call fails or returns an unexpected shape.
---

# Known Errors

Before repeating an external effect, read its saved operation/result and follow the active workflow’s recovery and budget policy. A lost response or timeout may be an unknown outcome; do not change operation IDs, providers or input to disguise a resubmission. Local schema/format fixes are not new provider requests.

`edit_item` update raw shape:

- Wrong: `{ "id": "abc", "fromFrame": 30 }`
- Right: `{ "json": "{\"updates\":[{\"id\":\"abc\",\"fromFrame\":30}]}" }`
- Use this same `updates` shape for common moves, trims, and track changes.

`edit_item` add raw shape:

- The new item goes inside the `adds` array of the `json` transaction: `{ "json": "{\"adds\":[{...}]}" }`.
- Use `edit_item` for simple video placement, for example `{ "json": "{\"adds\":[{\"type\":\"video\",\"assetId\":\"...\",\"fromFrame\":0}]}" }`.

Timeline overlap:

- Error text: `Overlap: updated item at ... would overlap existing item at ... on this track.`
- Do not force the write or delete the conflicting item silently.
- Retry the `edit_item` transaction with an explicit available `trackId`, for example an update containing `"trackId":"V2"`, or ask the user which layer should win.

Workspace path restrictions:

- `push_asset` on the external MCP only accepts public http(s) URLs as `filePath`. It rejects local paths, workspace paths, and chat attachment paths.
- For motion-graphic assets, pass the JSX source via `create_motion_graphic_from_code({ code:"...", name, width, height, durationInFrames })`. `push_asset` no longer accepts an inline `code` argument.
- Copying local media into the workspace is not the fix for video/audio/image/GIF imports; use `asset-import` and `import_media` instead.
- Use `import_media action=create_session`, then run the OpenChatCut media import helper once with the returned token for client-held files.

Browser video conversion failure:

- Error text often includes `Unable to convert video without dropping audio/video tracks` or `unknown_source_codec`.
- Read the helper’s conversion failure and saved upload/finalize result first. A codec/unsupported-conversion error will not improve by resubmitting the same file unchanged. For an incomplete local preparation, repair that preparation through the existing import helper instead of duplicating a successful upload.
- Do not ask the user to re-import the same file through the editor UI as a workaround. If conversion is genuinely required, preserve the original and use the supported loss/track-preserving conversion with the task’s permission; report any changed media properties. Do not silently degrade evidence video to force success.
- After replacement, verify the actual referenced asset and timeline instances. Preserve failed-attempt records and existing assets; deletion is a separate authorized cleanup, not part of recovering a usable file.

Motion Graphic requirements:

- `push_asset(type:"motion-graphic")` requires `width`, `height`, and `duration` or `durationInFrames`.
- MG code must pass the OpenChatCut validator.
- Root `AbsoluteFill` is not valid for generated MG code; use a scaling root `div`.
- Avoid declaring a top-level local named `scale` inside MG code. The validator/runtime may already reserve that identifier; use a specific name such as `uiScale`.

Local dev Zero caveat:

- When backend runs on a non-default port, use a matching Zero view-syncer configuration.
- In this POC, backend `3010`, editor `5177`, and view-syncer `4850` are intentionally isolated from the older `3000/5173/4848` stack.

Timeline frame renderer caveat:

- If `view_timeline_frames` fails for one frame, the project write path can still be healthy. Diagnose the local extraction, source and requested frame first; a different sample can narrow a fault but cannot prove the required failed frame or substitute a requested representative video.
- Assets still on `blob:` placeholders (upload in flight) render as empty; wait for `track_progress` target=upload before treating a blank frame as a bug.
- Do not report visual proof success unless the tool returns image content that visibly confirms the target frame.
