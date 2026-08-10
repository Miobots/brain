import type { ProviderKind } from '../config.js';

const nativeFileSupport: Record<ProviderKind, Set<string>> = {
  anthropic: new Set(['application/pdf']),
  google: new Set(['application/pdf']),
  'openai-compatible': new Set(), // generic assume no native file input unless proven otherwise
};

export function supportsNativeFile(kind: ProviderKind, mediaType: string): boolean {
  return nativeFileSupport[kind]?.has(mediaType) ?? false;
}