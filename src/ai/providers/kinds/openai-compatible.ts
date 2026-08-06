import { createOpenAI } from '@ai-sdk/openai';
import { AiConfigError } from '../../errors.js';
import type { ChatModelFactory } from '../provider-factory.js';
 
/**
 * THE IMPORTANT ONE.
 *
 * OpenAI itself, OpenRouter, Groq, DeepSeek, Together, Fireworks, a local vLLM or
 * Ollama box — all of them speak the OpenAI chat-completions protocol, so all of them
 * come through this single adapter. Adding any of them is purely an .env change:
 *
 *   AI_PROVIDER_<NAME>_KIND=openai-compatible
 *   AI_PROVIDER_<NAME>_API_KEY=...
 *   AI_PROVIDER_<NAME>_BASE_URL=https://...
 *
 * This is what "we're on a budget, the key can be literally anything" resolves to
 * architecturally: one adapter, N vendors, zero code per vendor.
 */
export const createOpenAiCompatibleModel: ChatModelFactory = (model, creds) => {
  if (!creds.baseUrl) {
    throw new AiConfigError(
      `kind 'openai-compatible' requires a baseUrl (model: ${model})`,"invalid_request"
    );
  }
 
  return createOpenAI({
    apiKey: creds.apiKey,
    baseURL: creds.baseUrl,
    // TODO(fill in): some gateways want extra headers (OpenRouter likes HTTP-Referer
    // and X-Title for attribution). Add a `headers` field to ProviderCredentials and
    // pass it through here if/when you hit that.
  })(model);
};