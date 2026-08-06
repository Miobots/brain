import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ChatModelFactory } from '../provider-factory.js';
 

export const createGoogleModel: ChatModelFactory = (model, creds) =>
  createGoogleGenerativeAI({
    apiKey: creds.apiKey,
    ...(creds.baseUrl ? { baseURL: creds.baseUrl } : {}),
  })(model);
 