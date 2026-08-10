import { APICallError } from 'ai';
import type { AiErrorCode } from './types.js';

function statusToCode(status: number): AiErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'invalid_model';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status >= 500) return 'provider_unreachable';
  return 'unknown';
}


export function classifyError(err: unknown): { code: AiErrorCode; message: string } {
  if (APICallError.isInstance(err)) {
    const code = err.statusCode !== undefined
      ? statusToCode(err.statusCode)
      : err.isRetryable
        ? 'provider_unreachable'
        : 'unknown';
    return { code, message: err.message };
  }

  const message = err instanceof Error ? err.message : String(err);

  if (/missing env var|is required for kind/i.test(message)) return { code: 'not_configured', message };
  if (/abort|timeout/i.test(message)) return { code: 'timeout', message };
  if (/enotfound|econnrefused|econnreset|fetch failed|network/i.test(message)) {
    return { code: 'provider_unreachable', message };
  }
  return { code: 'unknown', message };
}