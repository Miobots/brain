import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { Credentials } from '../../config.js';

export function buildAnthropicModel(model: string, creds: Credentials): LanguageModel {
  return createAnthropic({ apiKey: creds.apiKey })(model);
}