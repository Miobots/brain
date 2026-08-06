import { classifyError } from '../errors.js';
import { withTimeout } from '../chat-resolver.js';
import type { Logger } from '../logger.js';
import type { RequestQueue } from '../queue/request-queue.js';
import type { SpeechRequest, SpeechResult } from '../interface.js';
import { SpeechRegistry, toSynthesizeOptions } from './speech-registry.js';
 

export class SpeechResolver {
  constructor(
    private readonly registry: SpeechRegistry,
    private readonly queue: RequestQueue,
    private readonly logger: Logger,
  ) {}
 
  async speak(req: SpeechRequest): Promise<SpeechResult> {
    let provider: string | undefined;
    let modelName: string | undefined;
    const started = Date.now();
 
    try {
      const resolved = this.registry.resolveSpeechModel();
      provider = resolved.provider;
      modelName = resolved.modelName;
 
      const opts = toSynthesizeOptions(req, resolved.credentials.defaultVoice);
      const timeoutMs = resolved.credentials.timeoutMs ?? 30_000;
 
      const audio = await this.queue.enqueue(resolved.provider, () =>
        withTimeout(resolved.synthesize(req.text, opts), timeoutMs),
      );
 
      const latencyMs = Date.now() - started;
 
      this.logger.info({
        event: 'ai.speak.ok',
        correlationId: req.correlationId,
        provider: resolved.provider,
        model: resolved.modelName,
        chars: req.text.length,
        bytes: audio.byteLength,
        latencyMs,
      });
 
      return {
        ok: true,
        correlationId: req.correlationId,
        audio,
        format: opts.format,
        provider: resolved.provider,
        model: resolved.modelName,
        latencyMs,
      };
    } catch (err) {
      const detail = classifyError(err, { provider, model: modelName });
 
      this.logger.error({
        event: 'ai.speak.failed',
        correlationId: req.correlationId,
        provider,
        model: modelName,
        code: detail.code,
        message: detail.message,
        latencyMs: Date.now() - started,
        err,
      });
 
      return { ok: false, correlationId: req.correlationId, error: detail };
    }
  }
}