import { createAnthropic } from '@ai-sdk/anthropic';
import type { ChatModelFactory } from '../provider-factory.js';
 

export const createAnthropicModel: ChatModelFactory = (model, creds) =>
  createAnthropic({
    apiKey: creds.apiKey,
    ...(creds.baseUrl ? { baseURL: creds.baseUrl } : {}),
  })(model);
 