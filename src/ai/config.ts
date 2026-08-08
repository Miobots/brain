export type ProviderKind = 'anthropic' | 'google' | 'openai-compatible';

export interface Credentials {
  kind: ProviderKind;
  apiKey: string;
  baseUrl?: string;
}

function need(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

//gets provider and its model name
export function getCapabilityBinding(
  capability: string,
  env: NodeJS.ProcessEnv = process.env,
): { provider: string; model: string } {
  const prefix = capability.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return {
    provider: need(env, `AI_${prefix}_PROVIDER`),
    model: need(env, `AI_${prefix}_MODEL`),
  };
}

// extracts provider api keeys and base url based o provider kind and returns a credential object
export function getProviderCredentials(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): Credentials {
  const prefix = `AI_PROVIDER_${provider.trim().toUpperCase().replace(/[\s-]+/g, '_')}`;
  const kind = need(env, `${prefix}_KIND`) as ProviderKind;
  const apiKey = need(env, `${prefix}_API_KEY`);
  const baseUrl = env[`${prefix}_BASE_URL`];

  if (kind === 'openai-compatible' && !baseUrl) {
    throw new Error(`${prefix}_BASE_URL is required for kind 'openai-compatible'`);
  }
  return { kind, apiKey, baseUrl };
}