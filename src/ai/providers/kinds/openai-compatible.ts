import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { Credentials } from '../../config.js';


export function buildOpenAiCompatibleModel(model: string, creds: Credentials): LanguageModel {
  if (!creds.baseUrl) throw new Error("kind 'openai-compatible' requires a baseUrl");
  return createOpenAI({ apiKey: creds.apiKey, baseURL: creds.baseUrl })(model);
}