import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

import { generateAiVoice, isAiVoiceProvider } from './voice-ai-sdk.ts';
import { saveVoiceAudio, saveVoiceSubtitle } from './voice-media.ts';
import { doubaoVoice, elevenLabsVoice, fishAudioVoice, inworldVoice, minimaxVoice, speechifyVoice } from './voice-providers.ts';
import type { VoiceOptions, VoiceProvider, VoiceRequest } from './voice-types.ts';
import {bindMinimaxWordSubtitle,optionalVoiceSubtitle} from './voice-word-timing.ts';
import { validateVoiceRequest } from './voice-validation.ts';

export { validateVoiceRequest };

async function readJson(req: IncomingMessage): Promise<VoiceRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 1_000_000) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as VoiceRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function audioDescriptor(provider: VoiceProvider, outputFormat: string, audioFormat: string, sampleRate: number) {
  if (provider === 'elevenlabs') {
    const [codec, rate] = outputFormat.split('_');
    return { codec, sampleRate: Number(rate) };
  }
  if (provider === 'minimax') return { codec: audioFormat, sampleRate };
  return { codec: 'mp3', sampleRate: 24_000 };
}

export function voiceGenerationPlugin(options: VoiceOptions): Plugin {
  return {
    name: 'openchatcut-voice-generation',
    configureServer(server) {
      server.middlewares.use('/generate/voice', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const input = validateVoiceRequest(await readJson(req));
          if(req.headers['x-clipmentor-recover']==='1'&&input.provider!=='minimax')throw Error('Saved voice recovery unavailable for this provider; do not resubmit');
          if (isAiVoiceProvider(input.provider)) {
            const audio = await generateAiVoice(options, input);
            const saved = await saveVoiceAudio(audio.bytes, audio.codec, audio.sampleRate);
            sendJson(res, 200, saved);
            return;
          }
          let bytes: Buffer;
          let subtitleUrl: string | undefined;
          if (input.provider === 'minimax') {
            const scope=req.headers['x-clipmentor-project'];
            const operation=req.headers['x-clipmentor-operation'];
            if(scope!==undefined&&(typeof scope!=='string'||!(/^[a-zA-Z0-9_-]{1,160}$/).test(scope)))throw Error('Invalid voice project scope');
            if(operation!==undefined&&(typeof operation!=='string'||!(/^[a-zA-Z0-9_-]{1,128}$/).test(operation)))throw Error('Invalid voice operation');
            const controller=new AbortController();const disconnected=()=>controller.abort();
            res.once('close',disconnected);
            let result;
            try{result=await minimaxVoice(options,input,{scope:typeof scope==='string'?scope:undefined,operationId:typeof operation==='string'?operation:undefined,signal:controller.signal,readOnly:req.headers['x-clipmentor-recover']==='1'});}
            finally{res.removeListener('close',disconnected);}
            bytes = result.audio;
            subtitleUrl = result.subtitleUrl;
          } else if (input.provider === 'elevenlabs') bytes = await elevenLabsVoice(options, input);
          else if (input.provider === 'doubao') bytes = await doubaoVoice(options, input);
          else if (input.provider === 'inworld') bytes = await inworldVoice(options, input);
          else if (input.provider === 'fishaudio') bytes = await fishAudioVoice(options, input);
          else bytes = await speechifyVoice(options, input);
          const audio = audioDescriptor(input.provider, input.outputFormat, input.audioFormat, input.sampleRate);
          const saved = await saveVoiceAudio(bytes, audio.codec, audio.sampleRate, input.provider === 'doubao' ? input.pitch ?? 0 : 0);
          const timing=await optionalVoiceSubtitle(async()=>{
          const subtitlePath = subtitleUrl ? await saveVoiceSubtitle(subtitleUrl) : undefined;
          const subtitleBinding=input.provider==='minimax'&&input.subtitleEnable===true&&input.subtitleType==='word'&&!input.stream&&subtitlePath
            ?await bindMinimaxWordSubtitle(input.text,saved,subtitlePath):undefined;
          return {subtitlePath,subtitleBinding};
          });
          sendJson(res, 200, { ...saved, ...timing });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:voice] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
