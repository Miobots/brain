import { describe, it, expect } from 'vitest';
import { AIOrchestrator } from './orchestrator.js';
import { ModelRegistry } from './model-registry.js';
import { FallbackManager } from './fallback-manager.js';

describe('AIOrchestrator', () => {
  it('gets a response from the primary model', async () => {
    const orchestrator = new AIOrchestrator(new FallbackManager(new ModelRegistry()));
    const res = await orchestrator.chat({
      corrId: 'test-1',
      transcript: 'Say hello in one word.',
      lang: 'en',
    });
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.modelUsed).toBeDefined();
  });

  it('falls back when the primary model name is wrong', async () => {
    const registry = new ModelRegistry();
    const fallback = new FallbackManager(registry);
    (fallback as any).order = ['nonexistent', 'gpt'];
    const res = await new AIOrchestrator(fallback).chat({
      corrId: 'test-2', transcript: 'ping', lang: 'en',
    });
    expect(res.modelUsed).toBe('gpt');
  });
});