import type { LanguageModel } from 'ai';
import { getCapabilityBinding, getProviderCredentials, type Credentials, type ProviderKind } from '../config.js';
import { buildAnthropicModel } from './kinds/anthropic.js';
import { buildGoogleModel } from './kinds/google.js';
import { buildOpenAiCompatibleModel } from './kinds/openai-compatible.js';

// maps provider kind to function type to build it 
const builders: Record<ProviderKind, (model: string, creds: Credentials) => LanguageModel> = {
  anthropic: buildAnthropicModel,
  google: buildGoogleModel,
  'openai-compatible': buildOpenAiCompatibleModel,
};

const cache = new Map<string, LanguageModel>();

export function resolveModel(capability: string) {
  const binding = getCapabilityBinding(capability);
  const creds = getProviderCredentials(binding.provider);
  const key = `${binding.provider}:${binding.model}`;

  let model = cache.get(key);
  if (!model) {
    model = builders[creds.kind](binding.model, creds);
    cache.set(key, model);
  }
  return { model, provider: binding.provider, modelName: binding.model };
}