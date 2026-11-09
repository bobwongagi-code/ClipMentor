---
name: transcription
description: Use for OpenChatCut timeline transcription, captions/subtitles, transcript search or readiness, bilingual captions and talking-head cleanup. ClipMentor source-analysis ASR follows the clipmentor skill’s governed original-source route, not this timeline retry workflow.
---

# Transcription

First identify the requested result: a source-analysis transcript or editable timeline captions. For ClipMentor source analysis, call `load_skill(name="clipmentor")` and use its authorized source-ASR operation; inspect saved outcomes through `read_clipmentor_analysis(view="source_asr", assetId, operationId)` before considering a new submission. Do not bypass that route with `transcribe_track` or a fresh `retry_transcription` call.

## Timeline captions and transcript

1. Read assets and timeline with `read_project`; identify the exact audio/video clip, its source and existing transcript status. Reuse a current transcript before requesting ASR.
2. For client-held media, call `load_skill(name="asset-import")` and finish the supported upload/finalize path. Finalize registers bytes but does not start ASR. Disk-backed `/media/uploads/` assets do not require S3 or a second import; an in-flight `blob:` placeholder is not yet usable.
3. Place the intended source on an audio/video track if it is not there. When ASR is requested and authorized, call `transcribe_track` with the actual track. It transcribes untranscribed clips on that track, so read the track’s contents first; it skips current transcripts and clips without audio.
4. Follow the actual result: `transcribe_track` can return transcript results in-call. If an existing import/generation job reports transcription pending/running, use `track_progress` with `target:"transcription"`, `action:"wait"` and the relevant asset IDs. Do not wait for a job that was never started.
5. Use `find_transcript` or `read_transcript` to inspect text and source word times. Use `edit_captions` action `enable` or `read_captions` once the transcript is ready.

```json
{"action":"wait","target":"transcription","assetIds":"<existing pending asset id>"}
```

If the bytes are actually missing, restore the registered source using the current import/relink route or its original URL where authorized. Do not repeatedly import the same available local file to make a remote-ready flag change. Ask for material only when the source cannot be recovered through the supported route.

## Waiting, failure and explicit retry

Read saved status, partial results and any retained operation receipt before issuing another ASR request. A wait expiring or losing a response does not prove the provider failed; an unknown outcome is not permission to start again or change operation IDs. Preserve the current task’s budgets and recovery policy.

For an existing pending job, use its deadline/status where supplied. Without one, prolonged waiting is a diagnostic: compare elapsed in-task waiting with duration (roughly `max(5 minutes, min(60 minutes, 2 × asset duration))`; if duration is unknown, 10 minutes). Those estimates do not authorize resubmission or override a shorter task deadline.

`manage_transcript action="retry_transcription"` forces a new ASR request and replaces the clip transcript. Use it only after a known failed attempt or an explicit transcript-refresh request, with an authorized additional attempt and no unresolved in-flight result. For ClipMentor, return to its original operation/recovery contract instead. A formatting or caption-range problem is a local repair, not a reason to regenerate speech recognition.

The retry target is a timeline item or track, not an `asset` argument:

```json
{"action":"retry_transcription","itemId":"<actual clip id>"}
```

Read the returned result before polling; this action can complete in-call. Retain a successful partial transcript when another clip fails.

## Local transcript and caption edits

- Empty captions can mean the current source range starts before the first spoken word. Check source-time scope and the captions item’s duration rather than resubmitting ASR.
- `manage_transcript action="fix"` repairs source text/speaker labels without a new recognition request; caption presentation uses `edit_captions`.
- Translation variants use `translation_ensure` for reuse when appropriate. Creating a missing translation is a separate external effect, subject to the task’s authorization.
- `clean_script` handles mechanical fixed fillers and batch pauses after transcript-ready media is on the timeline.

For editorial talking-head work, call `load_skill(name="talking-head-guide")`: use mechanical cleanup where appropriate, then Script (`read_script` → edit `timeline.md` → `apply_script`) for semantic repeated-take or coherence edits. Verify the resulting playback; a ready transcript alone does not establish listening or editorial acceptance.
