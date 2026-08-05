import { generateText, APICallError } from 'ai';
import { ModelRegistry } from './model-registry.js';
import { ChatRequest,ChatResponse } from './interface.js';
import { aiConfig } from './config.js';
type ModelName = "reasoning"|"gpt"|"gemini"
export class FallbackManager {
  private order= aiConfig.fallbackOrder;
  private failures = new Map<ModelName, number>();              
  private readonly primaryTimeoutMs = aiConfig.AI_PRIMARY_TIMEOUT_MS;                   
  private readonly maxFailuresBeforeSkip = 3;

  constructor(private models: ModelRegistry) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let lastError: unknown;

    for (const [i, name] of this.candidates().entries()) {
      try {
        const model = this.models.get(name);
        const timeoutMs = i === 0 ? this.primaryTimeoutMs : this.primaryTimeoutMs * 2;

        const { text } = await this.withTimeout(
          generateText({
            model,
            system: req.systemPrompt,
            prompt: req.transcript,
            maxRetries: 2, 
          }),
          timeoutMs,
        );

        this.recordSuccess(name);
        return { text, modelUsed: name, attempts: i + 1 };
      } catch (err) {
        lastError = err;
        this.recordFailure(name);
      }
    }
    throw new Error(`All models exhausted: ${String(lastError)}`);
  }
// model skipping added by ammar
  private candidates(): ModelName[] {
    return this.order.filter(
      (n) => (this.failures.get(n) ?? 0) < this.maxFailuresBeforeSkip,
    );
  }

  private recordSuccess(name: ModelName) { this.failures.set(name, 0); }
  private recordFailure(name: ModelName) {
    this.failures.set(name, (this.failures.get(name) ?? 0) + 1);
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
  }
}