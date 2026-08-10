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
  FinishReason,
  StreamHandle,
  ToolCall,
  ToolDefinition,
  AiClient
} from './types.js';
import { ProviderKind } from './config.js';


//converts application messages to AI SDK format messages 
//handles all types of messages such as tool calls and normal messages 
//and messages with attachments 
async function toModelMessages(messages: ChatMessage[],kind:ProviderKind): Promise<ModelMessage[]> {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
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

    const files = await resolveAttachments(m.attachments,kind);
    out.push({ role: m.role, content: [{ type: 'text', text: m.content }, ...files] } as ModelMessage);
  }
  return out;
}
//converts ur applications tool def into ai sdk format 
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

//converts AI SDK finish reason to our applications finish reason 
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


//FLOW : chat req -> resolve model from env -> convert messages to AI SDK format->
//convert tools to AI SDK format -> generate text function call -> normalise reponse -->chat success
//now we retrieve kind as well and send to resolve attachments
export async function chat(req: ChatRequest): Promise<ChatResult> {
  try {
    const { model, provider, modelName,kind } = resolveModel(req.capability);
    const messages = await toModelMessages(req.messages,kind);
    const tools = toToolSet(req.tools);

    const started = Date.now();
    const raw = await generateText({
      model,
      messages,
      ...(tools ? { tools } : {}),
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
      ...(raw.text ? { text: raw.text } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      files: raw.files.map((f) => ({ mediaType: f.mediaType, data: f.uint8Array })),
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
    console.error('[ai.chat] failed', { correlationId: req.correlationId, capability: req.capability, code, message });
    return { ok: false, correlationId: req.correlationId, capability: req.capability, error: { code, message } };
  }
}

//same flow as the function above just different sdk function call for streaming responses
export async function stream(req: ChatRequest): Promise<StreamHandle> {
  const { model, provider, modelName ,kind} = resolveModel(req.capability);
  const messages = await toModelMessages(req.messages,kind);
  const tools = toToolSet(req.tools);
  const started = Date.now();

  const raw = streamText({
    model,
    messages,
    ...(tools ? { tools } : {}),
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
      const files = await raw.files;

      const toolCalls: ToolCall[] = toolCallsRaw.map((c) => ({
        id: c.toolCallId,
        name: c.toolName,
        arguments: (c.input ?? {}) as Record<string, unknown>,
        result: toolResultsRaw.find((r) => r.toolCallId === c.toolCallId)?.output,
      }));

      return {
        ok: true,
        correlationId: req.correlationId,
        ...(text ? { text } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
        files: files.map((f) => ({ mediaType: f.mediaType, data: f.uint8Array })),
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
      console.error('[ai.stream] failed', { correlationId: req.correlationId, capability: req.capability, code, message });
      return { ok: false, correlationId: req.correlationId, capability: req.capability, error: { code, message } };
    }
  })();

  return { textStream: raw.textStream, final };
}

export function createAiClient(): AiClient {
  return { chat, stream };
}