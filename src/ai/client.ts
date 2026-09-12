/**
 * AI client implementation backed by Vercel AI SDK.
 *
 * RETRY POLICY & OWNERSHIP:
 * `maxRetries` is explicitly set to 0 on both `generateText` and `streamText`.
 * Transient errors (such as rate limits, timeouts, provider outages) are caught,
 * classified into typed `AiErrorCode` values, and returned to the caller via `ChatFailure`.
 * Turn-level retry policy, backoff timing, and user feedback are owned by the caller / agent loop (`src/brain/agent.ts`).
 */

import { generateText, streamText, jsonSchema, type ModelMessage, type ToolSet } from 'ai';
import { resolveModel } from './providers/resolve.js';
import { resolveAttachments } from './attachments/resolve.js';
import { builtinTools } from './tools/index.js';
import { classifyError } from './errors.js';

import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatSuccess,
  ChatFailure,
  FinishReason,
  StreamHandle,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  AiClient
} from './types.js';
import { ProviderKind } from './config.js';

// converts application messages to AI SDK format messages
// handles all types of messages such as tool calls and normal messages with attachments
async function toModelMessages(messages: ChatMessage[], kind: ProviderKind): Promise<ModelMessage[]> {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      // Tool results are text-only outputs in the wire protocol and do not carry attachments.
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId ?? '',
            toolName: m.name ?? '',
            output: { type: 'text', value: m.content },
          },
        ],
      });
      continue;
    }

    if (!m.attachments?.length) {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    const files = await resolveAttachments(m.attachments, kind);
    out.push({ role: m.role, content: [{ type: 'text', text: m.content }, ...files] } as ModelMessage);
  }
  return out;
}

// converts application tool definition into AI SDK format
function toToolSet(tools: ToolDefinition[] | undefined): ToolSet | undefined {
  const all = [...builtinTools, ...(tools ?? [])];
  if (!all.length) return undefined;

  const set: ToolSet = {};
  for (const t of all) {
    set[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.parameters),
      ...(t.execute ? { execute: (input: Record<string, unknown>) => t.execute!(input) } : {}),
    };
  }
  return set;
}

// converts application ToolChoice into AI SDK format
function toAiSdkToolChoice(
  toolChoice: ToolChoice | undefined
): 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string } | undefined {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') {
    return toolChoice;
  }
  if ('name' in toolChoice && typeof toolChoice.name === 'string') {
    return { type: 'tool', toolName: toolChoice.name };
  }
  return undefined;
}

// converts AI SDK finish reason to our application finish reason
function mapFinishReason(r: string | undefined): FinishReason {
  switch (r) {
    case 'stop': return 'stop';
    case 'tool-calls': return 'tool_calls';
    case 'length': return 'length';
    case 'content-filter': return 'content_filter';
    case 'error': return 'error';
    default: return 'unknown';
  }
}

// FLOW: chat req -> resolve model from env -> convert messages to AI SDK format ->
// convert tools to AI SDK format -> generate text function call -> normalize response -> ChatResult
export async function chat(req: ChatRequest): Promise<ChatResult> {
  try {
    const { model, provider, modelName, kind } = resolveModel(req.capability);
    const messages = await toModelMessages(req.messages, kind);
    const tools = toToolSet(req.tools);
    const aiToolChoice = toAiSdkToolChoice(req.toolChoice);

    const started = Date.now();
    const raw = await generateText({
      model,
      messages,
      ...(tools ? { tools } : {}),
      ...(aiToolChoice ? { toolChoice: aiToolChoice } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      maxRetries: 0,
    });
    const latencyMs = Date.now() - started;

    const toolCalls: ToolCall[] = raw.toolCalls.map((c) => ({
      id: c.toolCallId,
      name: c.toolName,
      arguments: (c.input ?? {}) as Record<string, unknown>,
      result: raw.toolResults.find((r) => r.toolCallId === c.toolCallId)?.output,
    }));

    const result: ChatSuccess = {
      ok: true,
      correlationId: req.correlationId,
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      ...(req.userId ? { userId: req.userId } : {}),
      ...(req.metadata ? { metadata: req.metadata } : {}),
      ...(raw.text ? { text: raw.text } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      files: (raw.files ?? []).map((f) => ({ mediaType: f.mediaType, data: f.uint8Array })),
      finishReason: mapFinishReason(raw.finishReason),
      provider,
      model: modelName,
      capability: req.capability,
      usage: {
        promptTokens: raw.usage?.inputTokens ?? 0,
        completionTokens: raw.usage?.outputTokens ?? 0,
        totalTokens: raw.usage?.totalTokens ?? 0,
      },
      latencyMs,
    };
    return result;
  } catch (err) {
    const { code, message } = classifyError(err);
    console.error('[ai.chat] failed', {
      correlationId: req.correlationId,
      sessionId: req.sessionId,
      userId: req.userId,
      capability: req.capability,
      code,
      message,
    });
    return {
      ok: false,
      correlationId: req.correlationId,
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      ...(req.userId ? { userId: req.userId } : {}),
      capability: req.capability,
      error: { code, message },
    };
  }
}

// streaming flow matching chat() with typed failure and unhandled error safety
export async function stream(req: ChatRequest): Promise<StreamHandle> {
  try {
    const { model, provider, modelName, kind } = resolveModel(req.capability);
    const messages = await toModelMessages(req.messages, kind);
    const tools = toToolSet(req.tools);
    const aiToolChoice = toAiSdkToolChoice(req.toolChoice);
    const started = Date.now();

    const raw = streamText({
      model,
      messages,
      ...(tools ? { tools } : {}),
      ...(aiToolChoice ? { toolChoice: aiToolChoice } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      maxRetries: 0,
    });

    const final: Promise<ChatResult> = (async () => {
      try {
        const text = await raw.text;
        const toolCallsRaw = await raw.toolCalls;
        const toolResultsRaw = await raw.toolResults;
        const usage = await raw.usage;
        const finishReason = await raw.finishReason;
        const files = await (raw.files ?? []);

        const toolCalls: ToolCall[] = (toolCallsRaw ?? []).map((c) => ({
          id: c.toolCallId,
          name: c.toolName,
          arguments: (c.input ?? {}) as Record<string, unknown>,
          result: (toolResultsRaw ?? []).find((r) => r.toolCallId === c.toolCallId)?.output,
        }));

        return {
          ok: true,
          correlationId: req.correlationId,
          ...(req.sessionId ? { sessionId: req.sessionId } : {}),
          ...(req.userId ? { userId: req.userId } : {}),
          ...(req.metadata ? { metadata: req.metadata } : {}),
          ...(text ? { text } : {}),
          ...(toolCalls.length ? { toolCalls } : {}),
          files: (files ?? []).map((f) => ({ mediaType: f.mediaType, data: f.uint8Array })),
          finishReason: mapFinishReason(finishReason),
          provider,
          model: modelName,
          capability: req.capability,
          usage: {
            promptTokens: usage?.inputTokens ?? 0,
            completionTokens: usage?.outputTokens ?? 0,
            totalTokens: usage?.totalTokens ?? 0,
          },
          latencyMs: Date.now() - started,
        } satisfies ChatSuccess;
      } catch (err) {
        const { code, message } = classifyError(err);
        console.error('[ai.stream] failed', {
          correlationId: req.correlationId,
          sessionId: req.sessionId,
          userId: req.userId,
          capability: req.capability,
          code,
          message,
        });
        return {
          ok: false,
          correlationId: req.correlationId,
          ...(req.sessionId ? { sessionId: req.sessionId } : {}),
          ...(req.userId ? { userId: req.userId } : {}),
          capability: req.capability,
          error: { code, message, provider, model: modelName },
        };
      }
    })();

    return { textStream: raw.textStream, final };
  } catch (err) {
    const { code, message } = classifyError(err);
    console.error('[ai.stream] setup failed', {
      correlationId: req.correlationId,
      sessionId: req.sessionId,
      userId: req.userId,
      capability: req.capability,
      code,
      message,
    });
    const failure: ChatFailure = {
      ok: false,
      correlationId: req.correlationId,
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      ...(req.userId ? { userId: req.userId } : {}),
      capability: req.capability,
      error: { code, message },
    };
    async function* emptyStream(): AsyncIterable<string> {}
    return { textStream: emptyStream(), final: Promise.resolve(failure) };
  }
}

export function createAiClient(): AiClient {
  return { chat, stream };
}