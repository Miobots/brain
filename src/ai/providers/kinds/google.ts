import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import type { Credentials } from '../../config.js';

export function buildGoogleModel(model: string, creds: Credentials): LanguageModel {
  return createGoogleGenerativeAI({ apiKey: creds.apiKey })(model);
}