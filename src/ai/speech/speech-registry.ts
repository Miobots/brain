
import { AiConfigError } from '../errors.js';
import type { SpeechProviderCredentials, ConfigProvider } from '../config/types.js';
import type { AudioFormat, SpeechRequest } from '../interface.js';
 

export interface SynthesizeOptions {
  voice?: string;
  format: AudioFormat;
  language?: string;
  speed?: number;
}
 
/** What every speech adapter must provide. */
export type SpeechSynthesizer = (
  text: string,
  opts: SynthesizeOptions,
) => Promise<Uint8Array>;
 
export interface ResolvedSpeechModel {
  synthesize: SpeechSynthesizer;
  provider: string;
  modelName: string;
  credentials: SpeechProviderCredentials;
}
 
export type SpeechAdapterFactory = (
  model: string,
  creds: SpeechProviderCredentials,
) => SpeechSynthesizer;
 
export class SpeechRegistry {
  private readonly cache = new Map<string, SpeechSynthesizer>();
 
  constructor(
    private readonly config: ConfigProvider,
    /**
     * kind -> adapter. Mirrors providers/provider-factory.ts. Only build out a second
     * entry when you actually adopt a second TTS vendor — don't pre-abstract this.
     */
    private readonly adapters: Record<string, SpeechAdapterFactory> = {
      'openai-compatible': createOpenAiCompatibleSpeech,
      elevenlabs: createElevenLabsSpeech,
    },
  ) {}
 
  resolveSpeechModel(): ResolvedSpeechModel {
    const binding = this.config.getSpeechBinding();
    const credentials = this.config.getSpeechProviderCredentials(binding.provider);
 
    const key = `${binding.provider}:${binding.model}`;
    let synthesize = this.cache.get(key);
 
    if (!synthesize) {
      const factory = this.adapters[credentials.kind];
      if (!factory) {
        throw new AiConfigError(
          `No speech adapter registered for kind "${credentials.kind}"`,"invalid_request"
        );
      }
      synthesize = factory(binding.model, credentials);
      this.cache.set(key, synthesize);
    }
 
    return { synthesize, provider: binding.provider, modelName: binding.model, credentials };
  }
 
  invalidate(): void {
    this.cache.clear();
  }
}
 
/* ------------------------------------------------------------------ *
 * Adapters — thin, one per vendor family. Same rule as chat: these are the
 * only speech files allowed to know a vendor's wire format.
 * ------------------------------------------------------------------ */
 
/**
 * OpenAI-compatible TTS (`POST /audio/speech`). Works for OpenAI itself and any
 * gateway that mirrors the endpoint.
 *
 * TODO(fill in): confirm the response is raw audio bytes on your chosen gateway; some
 * proxies wrap it in JSON/base64.
 */
export const createOpenAiCompatibleSpeech: SpeechAdapterFactory =
  (model, creds) => async (text, opts) => {
    const base = creds.baseUrl?.replace(/\/$/, '');
    if (!base) {
      throw new AiConfigError("speech kind 'openai-compatible' requires a baseUrl","invalid_request");
    }
 
    const res = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
        voice: opts.voice ?? creds.defaultVoice,
        response_format: opts.format,
        ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
      }),
    });
 
    if (!res.ok) {
      throw Object.assign(new Error(await safeText(res)), { statusCode: res.status });
    }
    return new Uint8Array(await res.arrayBuffer());
  };
 
/**
 * ElevenLabs.
 *
 * TODO(fill in): the voice id goes in the URL path, not the body, and the model id in
 * the body. Fill in the exact endpoint/format mapping when you pick a voice.
 */
export const createElevenLabsSpeech: SpeechAdapterFactory =
  (model, creds) => async (text, opts) => {
    const voice = opts.voice ?? creds.defaultVoice;
    if (!voice) {
      throw new AiConfigError(
        'ElevenLabs requires a voice — set AI_SPEECH_PROVIDER_ELEVENLABS_DEFAULT_VOICE or pass SpeechRequest.voice',
      "not_implemented");
    }
 
    const base = (creds.baseUrl ?? 'https://api.elevenlabs.io/v1').replace(/\/$/, '');
    const res = await fetch(`${base}/text-to-speech/${encodeURIComponent(voice)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xi-api-key': creds.apiKey,
      },
      body: JSON.stringify({ text, model_id: model }),
    });
 
    if (!res.ok) {
      throw Object.assign(new Error(await safeText(res)), { statusCode: res.status });
    }
    return new Uint8Array(await res.arrayBuffer());
  };
 
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `HTTP ${res.status}`;
  }
}
 
/** Defaults applied before an adapter sees the request. */
export function toSynthesizeOptions(
  req: SpeechRequest,
  fallbackVoice?: string,
): SynthesizeOptions {
  return {
    voice: req.voice ?? fallbackVoice,
    format: req.format ?? 'mp3',
    language: req.language,
    speed: req.speed,
  };
}