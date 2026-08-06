import type { LanguageModel } from 'ai';
import type { Capability } from './interface.js';
import type { ConfigProvider, ProviderCredentials } from './config/types.js';
import { createLanguageModel } from './providers/provider-factory.js';
 
 
export interface ResolvedChatModel {
  model: LanguageModel;
  provider: string;
  modelName: string;
  credentials: ProviderCredentials;
}
 
export class ModelRegistry {
  private readonly cache = new Map<string, LanguageModel>();
 
  constructor(private readonly config: ConfigProvider) {}
 
  resolveChatModel(capability: Capability): ResolvedChatModel {
    const binding = this.config.getCapabilityBinding(capability);
    const credentials = this.config.getProviderCredentials(binding.provider);
 
    const key = `${binding.provider}:${binding.model}`;
    let model = this.cache.get(key);
 
    if (!model) {
      model = createLanguageModel(credentials.kind, binding.model, credentials);
      this.cache.set(key, model);
    }
 
    return {
      model,
      provider: binding.provider,
      modelName: binding.model,
      credentials,
    };
  }

  invalidate(provider?: string): void {
    if (!provider) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${provider}:`)) this.cache.delete(key);
    }
  }
}