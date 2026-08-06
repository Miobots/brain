import { Experimental_Agent } from "ai";
import { AiErrorCode,AiErrorDetail } from "./interface.js";
import { APICallError } from "ai";


export class AiConfigError extends Error{
    readonly code : AiErrorCode;

    constructor(message:string, code:AiErrorCode){
        super(message)
        this.name = 'AiConfigError'
        this.code=code
    }
}

export class AiTimeoutError extends Error{
    readonly code : AiErrorCode = "timeout"

    constructor(ms:number){
        super(`Ai call exceeded ${ms}ms`)
        this.name= 'AiTimeoutError'
    }
}

export function classifyError(
  err: unknown,
  ctx: { provider?: string; model?: string } = {},
): AiErrorDetail {
  const base = { provider: ctx.provider, model: ctx.model, cause: err };
 
  if (err instanceof AiConfigError) {
    return { code: err.code, message: err.message, ...base };
  }
  if (err instanceof AiTimeoutError) {
    return { code: 'timeout', message: err.message, ...base };
  }
 
  if (APICallError.isInstance(err)) {
    return {
      code:
        err.statusCode !== undefined
          ? statusToCode(err.statusCode)

            :err.isRetryable
            ? 'provider_unreachable'
            : 'unknown',
      message: err.message,

      retryable: err.isRetryable,
      ...base,
    };
  }
 

  if (isNamed(err, 'LoadAPIKeyError')) {
    return { code: 'auth', message: extractMessage(err), ...base };
  }
  if (isNamed(err, 'NoSuchModelError')) {
    return { code: 'invalid_model', message: extractMessage(err), ...base };
  }
  if (isNamed(err, 'InvalidPromptError', 'InvalidArgumentError', 'TypeValidationError')) {
    return { code: 'invalid_request', message: extractMessage(err), ...base };
  }
 
  const message = extractMessage(err);
  if (err instanceof Error && err.name === 'AbortError') {
    return { code: 'timeout', message, ...base };
  }
  if (/abort|timeout|etimedout/i.test(message)) {
    return { code: 'timeout', message, ...base };
  }
  if (/enotfound|econnrefused|econnreset|fetch failed|network/i.test(message)) {
    return { code: 'provider_unreachable', message, ...base };
  }
 
  return { code: 'unknown', message, ...base };
}
 
function isNamed(err: unknown, ...names: string[]): boolean {
  return err instanceof Error && names.includes(err.name);
}
 
function statusToCode(status: number): AiErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'invalid_model';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status >= 500) return 'provider_unreachable';
  return 'unknown';
}
 
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown AI error';
}