import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chat, stream } from '../../../src/ai/client';

describe('AI Client (src/ai/client.ts)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('Configuration & Error Parity (chat vs stream)', () => {
    it('chat() returns ChatFailure with not_configured on missing env variables', async () => {
      delete process.env.AI_FAST_PROVIDER;
      delete process.env.AI_FAST_MODEL;

      const res = await chat({
        correlationId: 'test-corr-1',
        capability: 'fast',
        messages: [{ role: 'user', content: 'hello' }],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('not_configured');
        expect(res.correlationId).toBe('test-corr-1');
        expect(res.capability).toBe('fast');
      }
    });

    it('stream() returns StreamHandle resolving to ChatFailure with not_configured on missing env variables', async () => {
      delete process.env.AI_FAST_PROVIDER;
      delete process.env.AI_FAST_MODEL;

      const handle = await stream({
        correlationId: 'test-corr-2',
        capability: 'fast',
        messages: [{ role: 'user', content: 'hello' }],
      });

      expect(handle).toBeDefined();
      expect(handle.textStream).toBeDefined();

      const res = await handle.final;
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('not_configured');
        expect(res.correlationId).toBe('test-corr-2');
        expect(res.capability).toBe('fast');
      }
    });

    it('chat() returns ChatFailure with not_configured on invalid provider kind', async () => {
      process.env.AI_REASONING_PROVIDER = 'bad-prov';
      process.env.AI_REASONING_MODEL = 'some-model';
      process.env.AI_PROVIDER_BAD_PROV_KIND = 'openai-compatable'; // Typo
      process.env.AI_PROVIDER_BAD_PROV_API_KEY = 'test-key';

      const res = await chat({
        correlationId: 'test-corr-3',
        capability: 'reasoning',
        messages: [{ role: 'user', content: 'hello' }],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('not_configured');
        expect(res.error.message).toContain('Invalid provider kind');
      }
    });

    it('stream() returns StreamHandle resolving to ChatFailure with not_configured on invalid provider kind', async () => {
      process.env.AI_REASONING_PROVIDER = 'bad-prov';
      process.env.AI_REASONING_MODEL = 'some-model';
      process.env.AI_PROVIDER_BAD_PROV_KIND = 'openai-compatable'; // Typo
      process.env.AI_PROVIDER_BAD_PROV_API_KEY = 'test-key';

      const handle = await stream({
        correlationId: 'test-corr-4',
        capability: 'reasoning',
        messages: [{ role: 'user', content: 'hello' }],
      });

      const res = await handle.final;
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('not_configured');
        expect(res.error.message).toContain('Invalid provider kind');
      }
    });
  });
});
