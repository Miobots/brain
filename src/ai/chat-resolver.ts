import { generateText, jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
import { AiTimeoutError, classifyError } from './errors.js';
import type { Logger } from './logger.js';
import type { ModelRegistry } from './model-registry.js';
import type { RequestQueue } from './queue/request-queue.js';
import type {
  ChatFailure,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatSuccess,
  FinishReason,
  ToolCall,
  ToolDefinition,
} from './interface.js';
 
/**
 * Replaces fallback-manager.ts.
 *
 * WHAT CHANGED AND WHY: the old manager looped over three hardcoded model aliases,
 * retrying each with a doubling timeout and a failure counter. Per your brief, that's
 * gone. One attempt, one clear structured answer for why it failed, logged. The
 * strategy interface below is the seam that lets retry/multi-provider come back later
 * without touching AiGateway or any Brain call site.
 */
 
export interface ResolverDeps {
  registry: ModelRegistry;
  queue: RequestQueue;
  logger: Logger;
}
 
export interface ResolutionStrategy {
  resolve(req: ChatRequest, deps: ResolverDeps): Promise<ChatResult>;
}
 
export class SingleAttemptStrategy implements ResolutionStrategy {
  async resolve(req: ChatRequest, deps: ResolverDeps): Promise<ChatResult> {
    const { registry, queue, logger } = deps;
 
    if (req.stream) {
      // Explicit rejection beats silently ignoring the flag.
      return failure(req, {
        code: 'not_implemented',
        message: 'Streaming is not implemented yet.',
      });
    }
 
    let provider: string | undefined;
    let modelName: string | undefined;
    const started = Date.now();
 
    try {
      const resolved = registry.resolveChatModel(req.capability);
      provider = resolved.provider;
      modelName = resolved.modelName;
 
      const timeoutMs = resolved.credentials.timeoutMs ?? 30_000;
 
      const raw = await queue.enqueue(resolved.provider, () =>
        withTimeout(
          generateText({
            model: resolved.model,
            messages: toModelMessages(req.messages),
            ...(req.tools?.length ? { tools: toToolSet(req.tools) } : {}),
            ...(req.toolChoice ? { toolChoice: toToolChoice(req.toolChoice) } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(req.maxOutputTokens !== undefined
              ? { maxOutputTokens: req.maxOutputTokens }
              : {}),
            // maxRetries 0: retry policy is this layer's decision, not the SDK's.
            maxRetries: 0,
          }),
          timeoutMs,
        ),
      );
 
      const result = toChatSuccess(req, raw, {
        provider: resolved.provider,
        model: resolved.modelName,
        latencyMs: Date.now() - started,
      });
 
      logger.info({
        event: 'ai.chat.ok',
        correlationId: req.correlationId,
        capability: req.capability,
        provider: result.provider,
        model: result.model,
        finishReason: result.finishReason,
        toolCalls: result.toolCalls?.length ?? 0,
        totalTokens: result.usage.totalTokens,
        latencyMs: result.latencyMs,
      });
 
      return result;
    } catch (err) {
      const detail = classifyError(err, { provider, model: modelName });
 
      logger.error({
        event: 'ai.chat.failed',
        correlationId: req.correlationId,
        sessionId: req.sessionId,
        capability: req.capability,
        provider,
        model: modelName,
        code: detail.code,
        message: detail.message,
        latencyMs: Date.now() - started,
        err,
      });
 
      return failure(req, detail);
    }
  }
}
 
/** What AiGateway holds. Thin by design — it exists so the strategy stays swappable. */
export class ChatResolver {
  constructor(
    private readonly deps: ResolverDeps,
    private readonly strategy: ResolutionStrategy = new SingleAttemptStrategy(),
  ) {}
 
  resolve(req: ChatRequest): Promise<ChatResult> {
    return this.strategy.resolve(req, this.deps);
  }
}
 
/* ------------------------------------------------------------------ *
 * Mapping: your types <-> Vercel AI SDK types.
 * This is the ONLY place the translation happens.
 * ------------------------------------------------------------------ */
 
/**
 * TODO(fill in): verify against the `ai@^7` message types you have installed. The
 * shape below is the common one; if your version differs, this function is the single
 * place to adjust — nothing else in the codebase knows about SDK message shapes.
 */
export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId ?? '',
            toolName: m.name ?? '',
            output: { type: 'text', value: asText(m.content) },
          },
        ],
      } as ModelMessage;
    }
 
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content } as ModelMessage;
    }
 
    return {
      role: m.role,
      content: m.content.map((part) =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : { type: 'image', image: part.image, mediaType: part.mimeType },
      ),
    } as ModelMessage;
  });
}
 
/**
 * ToolDefinition (plain JSON Schema) -> the SDK's ToolSet.
 *
 * Note there is NO `execute` function attached. That is deliberate and load-bearing:
 * with no executor the SDK returns the tool call to us instead of running it, which is
 * exactly the boundary we want — the AI layer decides WHAT to call, the Brain's
 * permission layer decides WHETHER, and the Brain executes.
 */
export function toToolSet(tools: ToolDefinition[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters),
    });
  }
  return set;
}
 
function toToolChoice(choice: NonNullable<ChatRequest['toolChoice']>) {
  return typeof choice === 'string' ? choice : { type: 'tool' as const, toolName: choice.name };
}
 
/** TODO(fill in): confirm field names on your installed `ai` version's GenerateTextResult. */
function toChatSuccess(
  req: ChatRequest,
  raw: Awaited<ReturnType<typeof generateText>>,
  meta: { provider: string; model: string; latencyMs: number },
): ChatSuccess {
  const toolCalls: ToolCall[] = (raw.toolCalls ?? []).map((c) => ({
    id: c.toolCallId,
    name: c.toolName,
    arguments: (c.input ?? {}) as Record<string, unknown>,
  }));
 
  return {
    ok: true,
    correlationId: req.correlationId,
    ...(raw.text ? { text: raw.text } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    finishReason: mapFinishReason(raw.finishReason),
    provider: meta.provider,
    model: meta.model,
    capability: req.capability,
    usage: {
      promptTokens: raw.usage?.inputTokens ?? 0,
      completionTokens: raw.usage?.outputTokens ?? 0,
      totalTokens: raw.usage?.totalTokens ?? 0,
    },
    latencyMs: meta.latencyMs,
  };
}
 
function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool-calls':
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content-filter':
    case 'content_filter':
      return 'content_filter';
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}
 
function failure(req: ChatRequest, error: ChatFailure['error']): ChatFailure {
  return {
    ok: false,
    correlationId: req.correlationId,
    capability: req.capability,
    error,
  };
}
 
function asText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}
 
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AiTimeoutError(ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}
 