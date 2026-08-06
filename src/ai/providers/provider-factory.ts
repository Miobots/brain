import type { LanguageModel } from 'ai';
import { AiConfigError } from '../errors.js';
import type { ProviderCredentials, ProviderKind } from '../config/types.js';
import { createAnthropicModel } from './kinds/anthropic.js';
import { createGoogleModel } from './kinds/google.js';
import { createOpenAiCompatibleModel } from './kinds/openai-compatible.js';

 

 
export type ChatModelFactory = (
  model: string,
  creds: ProviderCredentials,
) => LanguageModel;
 
const chatFactories: Record<ProviderKind, ChatModelFactory> = {
  anthropic: createAnthropicModel,
  google: createGoogleModel,
  'openai-compatible': createOpenAiCompatibleModel,
};
 
export function createLanguageModel(
  kind: ProviderKind,
  model: string,
  creds: ProviderCredentials,
): LanguageModel {
  const factory = chatFactories[kind];
  if (!factory) {
    throw new AiConfigError(`No adapter registered for provider kind "${kind}"`,"not_configured");
  }
  return factory(model, creds);
}