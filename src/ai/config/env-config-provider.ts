import { z } from 'zod';
import { AiConfigError } from '../errors.js';
import type { Capability } from '../interface.js';
import type {
  CapabilityBinding,
  ConfigProvider,
  ProviderCredentials,
  ProviderKind,
  SpeechProviderCredentials,
  SpeechProviderKind,
} from './types.js';
 
/**
 * Today's only ConfigProvider. Reads process.env.
 *
 * THIS IS THE ONLY FILE THAT GETS REPLACED when you move to a database. Write
 * DbConfigProvider implementing ConfigProvider, swap it in index.ts, delete nothing else.
 *
 * ---------------------------------------------------------------------------
 * Env shape — two independent axes, on purpose:
 *
 *   Capability bindings (WHAT backs each capability)
 *     AI_REASONING_PROVIDER=anthropic
 *     AI_REASONING_MODEL=claude-sonnet-5
 *     AI_FAST_PROVIDER=groq
 *     AI_FAST_MODEL=llama-3.3-70b-versatile
 *     AI_CHEAP_PROVIDER=openrouter
 *     AI_CHEAP_MODEL=deepseek/deepseek-chat
 *     AI_VISION_PROVIDER=anthropic
 *     AI_VISION_MODEL=claude-sonnet-5
 *     AI_SPEECH_PROVIDER=elevenlabs
 *     AI_SPEECH_MODEL=eleven_turbo_v2
 *
 *   Provider credentials (HOW to reach a provider)
 *     AI_PROVIDER_ANTHROPIC_KIND=anthropic
 *     AI_PROVIDER_ANTHROPIC_API_KEY=sk-...
 *
 *     AI_PROVIDER_GROQ_KIND=openai-compatible
 *     AI_PROVIDER_GROQ_API_KEY=gsk_...
 *     AI_PROVIDER_GROQ_BASE_URL=https://api.groq.com/openai/v1
 *     AI_PROVIDER_GROQ_MAX_CONCURRENCY=2
 *     AI_PROVIDER_GROQ_TIMEOUT_MS=30000
 *
 *     AI_SPEECH_PROVIDER_ELEVENLABS_KIND=elevenlabs
 *     AI_SPEECH_PROVIDER_ELEVENLABS_API_KEY=...
 *     AI_SPEECH_PROVIDER_ELEVENLABS_DEFAULT_VOICE=...
 *
 * Note there is no fixed list of provider names anywhere. Adding "cerebras" means
 * adding AI_PROVIDER_CEREBRAS_* to .env and pointing a capability at it. No code.
 * ---------------------------------------------------------------------------
 */
 
const providerKinds = ['anthropic', 'google', 'openai-compatible'] as const;
const speechProviderKinds = ['openai-compatible', 'elevenlabs'] as const;
 
const credentialsSchema = z.object({
  kind: z.enum(providerKinds),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  maxConcurrency: z.coerce.number().int().positive().default(2),
  timeoutMs: z.coerce.number().int().positive().default(30_000),
});
 
const speechCredentialsSchema = z.object({
  kind: z.enum(speechProviderKinds),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  defaultVoice: z.string().optional(),
  maxConcurrency: z.coerce.number().int().positive().default(2),
  timeoutMs: z.coerce.number().int().positive().default(30_000),
});
 
export class EnvConfigProvider implements ConfigProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
 
  getCapabilityBinding(capability: Capability): CapabilityBinding {
    return this.readBinding(this.envKeyForCapability(capability), capability);
  }
 
  getSpeechBinding(): CapabilityBinding {
    return this.readBinding('SPEECH', 'speech');
  }
 
  getProviderCredentials(provider: string): ProviderCredentials {
    const prefix = `AI_PROVIDER_${normalizeName(provider)}`;
    const parsed = credentialsSchema.safeParse({
      kind: this.env[`${prefix}_KIND`],
      apiKey: this.env[`${prefix}_API_KEY`],
      baseUrl: this.env[`${prefix}_BASE_URL`],
      maxConcurrency: this.env[`${prefix}_MAX_CONCURRENCY`],
      timeoutMs: this.env[`${prefix}_TIMEOUT_MS`],
    });
 
    if (!parsed.success) {
      throw new AiConfigError(
        `Provider "${provider}" is misconfigured (${prefix}_*): ` +
          JSON.stringify(parsed.error.flatten().fieldErrors),
        'not_configured',
      );
    }
 
    const creds = parsed.data;
    assertBaseUrlPresence(creds.kind, creds.baseUrl, provider, prefix);
    return creds;
  }
 
  getSpeechProviderCredentials(provider: string): SpeechProviderCredentials {
    const prefix = `AI_SPEECH_PROVIDER_${normalizeName(provider)}`;
    const parsed = speechCredentialsSchema.safeParse({
      kind: this.env[`${prefix}_KIND`],
      apiKey: this.env[`${prefix}_API_KEY`],
      baseUrl: this.env[`${prefix}_BASE_URL`],
      defaultVoice: this.env[`${prefix}_DEFAULT_VOICE`],
      maxConcurrency: this.env[`${prefix}_MAX_CONCURRENCY`],
      timeoutMs: this.env[`${prefix}_TIMEOUT_MS`],
    });
 
    if (!parsed.success) {
      throw new AiConfigError(
        `Speech provider "${provider}" is misconfigured (${prefix}_*): ` +
          JSON.stringify(parsed.error.flatten().fieldErrors),
        'not_configured',
      );
    }
    return parsed.data;
  }
 
  private readBinding(envKey: string, label: string): CapabilityBinding {
    const provider = this.env[`AI_${envKey}_PROVIDER`];
    const model = this.env[`AI_${envKey}_MODEL`];
 
    if (!provider || !model) {
      throw new AiConfigError(
        `Capability "${label}" is not bound. Set AI_${envKey}_PROVIDER and AI_${envKey}_MODEL.`,
        'not_configured',
      );
    }
    return { provider, model };
  }
 
  /** 'reasoning' -> 'REASONING'. Keeps capability names free-form without an enum lock. */
  private envKeyForCapability(capability: Capability): string {
    return normalizeName(capability);
  }
}
 
/** 'openai-compatible' and 'open router' both need to survive becoming an env key segment. */
function normalizeName(name: string): string {
  return name.trim().toUpperCase().replace(/[\s-]+/g, '_');
}
 
function assertBaseUrlPresence(
  kind: ProviderKind | SpeechProviderKind,
  baseUrl: string | undefined,
  provider: string,
  prefix: string,
): void {
  if (kind === 'openai-compatible' && !baseUrl) {
    throw new AiConfigError(
      `Provider "${provider}" has kind 'openai-compatible' but no ${prefix}_BASE_URL.`,
      'not_configured',
    );
  }
}