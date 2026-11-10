import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { minimaxVoiceBody } from './voice-providers.ts';
import { validateVoiceRequest } from './voice-validation.ts';
import type { VoiceRequest } from './voice-types.ts';

// Test the serialized request, not properties that JSON silently drops.
const base: VoiceRequest = { provider: 'minimax', text: 'Satu produk.', voiceId: 'fixture-voice' };
const body = (patch: VoiceRequest = {}) => JSON.parse(JSON.stringify(
  minimaxVoiceBody('speech-2.8-hd', validateVoiceRequest({ ...base, ...patch })),
));
type Case = () => void;
const mapped = <K extends keyof VoiceRequest>(key: K, value: VoiceRequest[K], path: string,
  expected: unknown = value, extra: VoiceRequest = {}): Case => () => {
  const actual = path.split('.').reduce((v, k) => v?.[k], body({ ...extra, [key]: value }));
  assert.deepEqual(actual, expected, `MiniMax must transmit ${key} as ${path}`);
};
const rejected = <K extends keyof VoiceRequest>(key: K, value: VoiceRequest[K]): Case => () => {
  assert.throws(() => body({ [key]: value }), /MiniMax does not accept/, `MiniMax must reject ${key}, not silently ignore it`);
};
const cases = {
  provider: () => { assert.equal(validateVoiceRequest(base).provider, 'minimax'); assert.throws(() => validateVoiceRequest({ ...base, provider: 'unknown' }), /unsupported voice provider/); },
  text: mapped('text', 'Teks lain.', 'text'),
  voiceId: mapped('voiceId', 'other-voice', 'voice_setting.voice_id'),
  modelId: rejected('modelId', 'other-model'),
  stability: rejected('stability', 0.4),
  speed: mapped('speed', 1.1, 'voice_setting.speed'),
  similarityBoost: rejected('similarityBoost', 0.4),
  style: rejected('style', 0.2),
  useSpeakerBoost: rejected('useSpeakerBoost', false),
  languageCode: rejected('languageCode', 'ms'),
  seed: rejected('seed', 42),
  outputFormat: rejected('outputFormat', 'wav_44100'),
  instructions: rejected('instructions', 'Read warmly'),
  optimizeStreamingLatency: rejected('optimizeStreamingLatency', 1),
  enableLogging: rejected('enableLogging', false),
  applyTextNormalization: rejected('applyTextNormalization', 'off'),
  applyLanguageTextNormalization: rejected('applyLanguageTextNormalization', false),
  pronunciationDictionaryLocators: rejected('pronunciationDictionaryLocators', [{ pronunciationDictionaryId: 'id', versionId: 'v1' }]),
  previousText: rejected('previousText', 'Before'),
  nextText: rejected('nextText', 'After'),
  previousRequestIds: rejected('previousRequestIds', ['before']),
  nextRequestIds: rejected('nextRequestIds', ['after']),
  speedRatio: rejected('speedRatio', 1.1),
  emotion: mapped('emotion', 'calm', 'voice_setting.emotion'),
  emotionScale: rejected('emotionScale', 2),
  loudnessRatio: rejected('loudnessRatio', 1.1),
  pitch: mapped('pitch', 0, 'voice_setting.pitch'),
  volume: mapped('volume', 1.3, 'voice_setting.vol'),
  performancePrompt: rejected('performancePrompt', 'Warm'),
  explicitDialect: rejected('explicitDialect', 'standard'),
  sampleRate: mapped('sampleRate', 44100, 'audio_setting.sample_rate'),
  bitrate: mapped('bitrate', 64000, 'audio_setting.bitrate'),
  audioFormat: mapped('audioFormat', 'flac', 'audio_setting.format'),
  channel: mapped('channel', 2, 'audio_setting.channel'),
  forceCbr: mapped('forceCbr', true, 'audio_setting.force_cbr', true, { stream: true }),
  stream: mapped('stream', true, 'stream'),
  excludeAggregatedAudio: mapped('excludeAggregatedAudio', false, 'stream_options.exclude_aggregated_audio', false, { stream: true }),
  languageBoost: mapped('languageBoost', 'Malay', 'language_boost'),
  textNormalization: mapped('textNormalization', false, 'voice_setting.text_normalization'),
  latexRead: () => { mapped('latexRead', true, 'voice_setting.latex_read')(); assert.equal(body({ latexRead: true }).language_boost, 'Chinese'); },
  pronunciations: mapped('pronunciations', ['nama/(na ma)'], 'pronunciation_dict.tone'),
  timbreWeights: mapped('timbreWeights', [{ voiceId: 'mixed', weight: 60 }], 'timbre_weights', [{ voice_id: 'mixed', weight: 60 }], { voiceId: '' }),
  voiceModify: mapped('voiceModify', { pitch: 0, intensity: -10, timbre: 15, effect: 'robotic' }, 'voice_modify', { pitch: 0, intensity: -10, timbre: 15, sound_effects: 'robotic' }),
  subtitleEnable: mapped('subtitleEnable', false, 'subtitle_enable'),
  subtitleType: mapped('subtitleType', 'word', 'subtitle_type', 'word', { subtitleEnable: true }),
} satisfies Record<keyof VoiceRequest, Case>;

// tsx does not type-check and verifiers are not all included by tsc. Keep this
// runtime assertion so adding a declared port cannot quietly skip this suite.
const source = ts.createSourceFile('voice-types.ts', readFileSync(new URL('./voice-types.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find((n): n is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(n) && n.name.text === 'VoiceRequest');
assert(declaration);
assert.deepEqual(Object.keys(cases).sort(), declaration.members.map(m => m.name!.getText(source)).sort(), 'Every declared voice parameter needs a MiniMax wire or refusal case');
for (const [name, run] of Object.entries(cases)) {
  try { run(); } catch (error) { throw new Error(`Voice parameter contract: ${name}`, { cause: error }); }
}
const defaults = body();
assert.equal(defaults.model, 'speech-2.8-hd');
assert.equal(defaults.stream, false);
assert.equal(defaults.output_format, 'hex');
assert.deepEqual(defaults.voice_setting, { voice_id: base.voiceId, speed: 1, vol: 1, pitch: 0 });
assert.deepEqual(defaults.audio_setting, { sample_rate: 32000, format: 'mp3', channel: 1, bitrate: 128000 });
assert.equal('stream_options' in defaults, false);
assert.equal('subtitle_type' in defaults, false);
// Known model restrictions must reject locally; do not silently swap models.
assert.throws(() => minimaxVoiceBody('speech-2.8-hd', validateVoiceRequest({ ...base, emotion: 'whisper' })), /does not support emotion/);
assert.throws(() => minimaxVoiceBody('speech-01-hd', validateVoiceRequest({ ...base, languageBoost: 'Tamil' })), /does not support languageBoost/);
for (const provider of ['elevenlabs', 'doubao', 'inworld', 'fishaudio', 'speechify']) {
  assert.throws(() => validateVoiceRequest({ ...base, provider, instructions: 'Read warmly' }), /does not accept|only accepts/);
}
for (const provider of ['openai', 'gemini']) {
  assert.equal(validateVoiceRequest({ ...base, provider, instructions: 'Read warmly' }).instructions, 'Read warmly', 'Supported AI voice instructions stay available');
}
console.log(`voice-parameter-coverage: ${Object.keys(cases).length} declared parameters transmitted or refused; frozen defaults retained`);
