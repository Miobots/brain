/**
 * THE PUBLIC BOUNDARY OF THE AI LAYER.
 *
 * src/brain/* imports from here and nowhere else under src/ai. If you ever find a
 * deep import like `from '../ai/providers/kinds/anthropic.js'` outside this directory,
 * the abstraction has leaked.
 */
 
export type {
  AiInterface,
  Capability,
  ChatMessage,
  ContentPart,
  ChatRequest,
  ChatResult,
  ChatSuccess,
  ChatFailure,
  FinishReason,
  TokenUsage,
  ToolDefinition,
  ToolCall,
  ToolChoice,
  JsonSchema,
  SpeechRequest,
  SpeechResult,
  SpeechSuccess,
  SpeechFailure,
  AudioFormat,
  AiErrorCode,
  AiErrorDetail,
} from './interface.js';
 
export { isChatSuccess, isSpeechSuccess } from './interface.js';
export type { ConfigProvider } from './config/types.js';
export type { Logger } from './logger.js';
 
import { EnvConfigProvider } from './config/env-config-provider.js';
import { ConsoleLogger, type Logger } from './logger.js';
import { ModelRegistry } from './model-registry.js';
import { ChatResolver, SingleAttemptStrategy, type ResolutionStrategy } from './chat-resolver.js';
import { InMemoryRequestQueue } from './queue/in-memory-queue.js';
import { SpeechRegistry } from './speech/speech-registry.js';
import { SpeechResolver } from './speech/speech-resolver.js';
import { AiGateway } from './gateway.js';
import type { ConfigProvider } from './config/types.js';
import type { AiInterface } from './interface.js';
 
export interface CreateAiGatewayOptions {

  config?: ConfigProvider;
  logger?: Logger;
 
  strategy?: ResolutionStrategy;

  defaultConcurrency?: number;
}
 

export function createAiGateway(opts: CreateAiGatewayOptions = {}): AiInterface {
  const config = opts.config ?? new EnvConfigProvider();
  const logger = opts.logger ?? new ConsoleLogger();
 
  const queue = new InMemoryRequestQueue(opts.defaultConcurrency ?? 2);
 
  const registry = new ModelRegistry(config);
  const speechRegistry = new SpeechRegistry(config);
 
  const chatResolver = new ChatResolver(
    { registry, queue, logger },
    opts.strategy ?? new SingleAttemptStrategy(),
  );
  const speechResolver = new SpeechResolver(speechRegistry, queue, logger);
 
  return new AiGateway(chatResolver, speechResolver);
}
 