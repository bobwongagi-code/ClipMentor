# MiniMax TTS (`provider: "minimax"`)

Read this before `submit_voice({ provider: "minimax", … })`.

Grounded in OpenChatCut’s voice tool + server adapter (`server/plugins/voice.ts` → MiniMax `t2a_v2`). Preset table: [voices.md](voices.md) § MiniMax.

## Capabilities (as wired)

| Dimension | Value |
| --- | --- |
| Provider arg | `minimax` |
| Text | Required |
| `voiceId` | System/raw/cloned MiniMax id; defaults to `female-yujie`. Must be empty when using `timbreWeights` |
| `speed` | Optional, **0.5–2** (default 1) → `voice_setting.speed` |
| `pitch` | Optional, **-12–12** (default 0) → native `voice_setting.pitch` |
| `volume` | Optional, **>0–10** (default 1) → `voice_setting.vol` |
| `emotion` | Optional: happy, sad, angry, fearful, disgusted, surprised, calm, fluent, whisper |
| Audio settings | sampleRate; mp3/pcm/flac/wav/pcmu/opus; channel. `bitrate` is MP3-only |
| Streaming | `stream`; `excludeAggregatedAudio`; `forceCbr` only with streamed MP3. OpenChatCut still persists one local asset |
| Language/text | languageBoost, textNormalization, latexRead, pronunciation tone entries |
| Voice composition | timbreWeights (1–4 voices, weights 1–100), voiceModify pitch/intensity/timbre/effect |
| Subtitle | `subtitleEnable` + sentence/word/word_streaming; non-streaming `subtitle_file` is downloaded as a durable JSON sidecar; inline streaming subtitles are not assembled here |
| Placement | **Media pool only** — does not place on the timeline |

## When to use

- MiniMax key is configured and the user wants MiniMax TTS.
- User named MiniMax speech (as distinct from Doubao / ElevenLabs).
- Only MiniMax voice capability is on.

## When not to use

- Need Doubao dialect / `performancePrompt` → `doubao`
- Need ElevenLabs multilingual catalog → `elevenlabs`
- User has not picked a voice → offer candidates from [voices.md](voices.md) first

## Tool shape

```ts
submit_voice({
  provider: "minimax",
  text: "……",
  voiceId: "female-yujie",
  speed: 1,
  pitch: 0,
  volume: 1,
  emotion: "calm", // optional
  sampleRate: 44100,
  audioFormat: "wav",
  languageBoost: "Chinese",
  subtitleEnable: true,
  subtitleType: "word",
  pronunciations: ["OpenChatCut/(open chat cut)"],
  voiceModify: { intensity: 10, effect: "spacious_echo" },
  name: "VO · intro",
});
```

Then place with `edit_item` only if the user wants it on a track.

For an already-authorized new ClipMentor synthesis that needs execution anchors, request `subtitleEnable: true`, `subtitleType: "word"`, `stream: false` in that same call. The original voice response stores the sidecar together with text, audio and subtitle hashes and the measured duration; browser and server execution retain that binding. The execution view validates the saved files before exposing word/caption boundaries. A word request alone does not prove that word timestamps were returned. Sentence-only, missing, malformed or mismatched results stay unavailable; timing is not independent listening or picture/review approval. Streaming inline subtitles are not handled by this file-sidecar anchor path. Do not synthesize unchanged existing audio again just to retrofit timestamps.

## Rules

- Never mix MiniMax `voiceId` values with `provider: "doubao"` or `"elevenlabs"`.
- Confirm a concrete `voiceId` before submit, except for a deliberate `timbreWeights` mix (empty `voiceId`).
- `voiceModify` supports non-streaming mp3/wav/flac or streaming mp3 only.
- `word_streaming`, `excludeAggregatedAudio`, and streamed `forceCbr` require `stream: true`.
- `textNormalization` and `latexRead` map inside official `voice_setting`; `latexRead` forces Chinese language boost.
- Check capabilities: if MiniMax voice is off, say which key is missing.
