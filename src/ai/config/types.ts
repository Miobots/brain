import type { Capability } from '../interface.js';
 

export type ProviderKind = 'anthropic' | 'google' | 'openai-compatible';
 
export type SpeechProviderKind = 'openai-compatible' | 'elevenlabs';
 

export interface CapabilityBinding {

  provider: string;
 
  model: string;
}
 
export interface ProviderCredentials {
  kind: ProviderKind;
  apiKey: string;
  
  baseUrl?: string;
 
  maxConcurrency?: number;

  timeoutMs?: number;
}
 
export interface SpeechProviderCredentials {
  kind: SpeechProviderKind;
  apiKey: string;
  baseUrl?: string;
  defaultVoice?: string;
  maxConcurrency?: number;
  timeoutMs?: number;
}
 
export interface ConfigProvider {

  getCapabilityBinding(capability: Capability): CapabilityBinding;
 
  getProviderCredentials(provider: string): ProviderCredentials;
 
  getSpeechBinding(): CapabilityBinding;
 
  getSpeechProviderCredentials(provider: string): SpeechProviderCredentials;
}