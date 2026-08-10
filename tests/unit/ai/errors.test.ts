import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { classifyError } from '../../../src/ai/errors';
import { APICallError } from 'ai';

describe('classifyError()', () => {
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    spy?.mockRestore?.();
    spy = undefined;
  });

  it('classifies missing config as not_configured', () => {
    const err = new Error('missing env var OPENAI_KEY is required');
    const res = classifyError(err);
    expect(res.code).toBe('not_configured');
    expect(res.message).toBe(err.message);
  });

  it('classifies timeout messages as timeout', () => {
    expect(classifyError('request aborted due to timeout').code).toBe('timeout');
    expect(classifyError(new Error('operation aborted')).code).toBe('timeout');
  });

  it('classifies network failures as provider_unreachable', () => {
    expect(classifyError('ENOTFOUND: fetch failed').code).toBe('provider_unreachable');
    expect(classifyError(new Error('connect ECONNREFUSED')).code).toBe('provider_unreachable');
  });

  it('returns unknown for other strings', () => {
    expect(classifyError('something odd happened').code).toBe('unknown');
  });

  it('handles APICallError instances via statusCode', () => {
    // stub APICallError.isInstance to return true for our fake object
    spy = vi.spyOn(APICallError, 'isInstance').mockImplementation(() => true as any);
    const fake = { statusCode: 401, message: 'unauthorized', isRetryable: false } as any;
    const res = classifyError(fake);
    expect(res.code).toBe('auth');
    expect(res.message).toBe('unauthorized');
  });

  it('handles APICallError retryable without statusCode', () => {
    spy = vi.spyOn(APICallError, 'isInstance').mockImplementation(() => true as any);
    const fake = { message: 'down', isRetryable: true } as any;
    const res = classifyError(fake);
    expect(res.code).toBe('provider_unreachable');
  });
});
