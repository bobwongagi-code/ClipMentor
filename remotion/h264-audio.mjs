import { rm } from 'node:fs/promises';
import { RenderInternals } from '@remotion/renderer';

// PCM MOV preserves the audio timeline until MP4 AAC can carry its priming-sample compensation.
export async function renderH264WithPcmAudio({ render, options }) {
  const output = options.outputLocation;
  if (!output) return render(options);

  const intermediate = `${output}.pcm.mov`;
  try {
    const result = await render({
      ...options,
      outputLocation: intermediate,
      audioCodec: 'pcm-16',
    });
    await RenderInternals.callFf({
      bin: 'ffmpeg',
      args: [
        '-hide_banner', '-y', '-i', intermediate,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'copy', '-c:a', 'libfdk_aac', '-b:a', '320k', '-cutoff', '18000',
        '-movflags', '+faststart', output,
      ],
      binariesDirectory: options.binariesDirectory ?? null,
      cancelSignal: options.cancelSignal,
      logLevel: 'error',
      indent: false,
    });
    return result;
  } finally {
    await rm(intermediate, { force: true }).catch(() => {});
  }
}
