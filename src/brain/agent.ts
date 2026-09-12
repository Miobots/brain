import { randomUUID } from "node:crypto";
import { chat } from "../ai/client.ts";
import type { ChatMessage, ToolCall, ToolDefinition } from "../ai/types.ts";
import { getTools, getTool } from "./tools.ts";

export const DEFAULT_MAX_ITERATIONS = 5;

export const SYSTEM_PROMPT =
  "You are Mio, an intelligent and friendly companion robot assistant. " +
  "You interact with users naturally and speak aloud or perform physical robot actions using your registered tools. " +
  "When the user asks you to say, speak, or greet someone in English or Urdu, invoke the speak tool with the requested text and appropriate language code ('en' or 'ur'). " +
  "Always execute physical actions via available tools rather than pretending you did.";

export interface AgentRequest {
  text: string;
  correlationId?: string;
  sessionId?: string;
  userId?: string;
  deviceId?: string;
  capability?: string;
  maxIterations?: number;
  systemPrompt?: string;
  tools?: ToolDefinition[];
}

export interface ExecutedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface AgentResponse {
  ok: boolean;
  text: string;
  correlationId: string;
  iterations: number;
  toolCalls: ExecutedToolCall[];
  error?: string;
}

export async function runAgentLoop(req: AgentRequest): Promise<AgentResponse> {
  const correlationId = req.correlationId ?? randomUUID();
  const maxIterations = req.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const capability = req.capability ?? "fast";
  const systemPrompt = req.systemPrompt ?? SYSTEM_PROMPT;
  const tools = req.tools ?? getTools();

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: req.text },
  ];

  const executedToolCalls: ExecutedToolCall[] = [];
  let iterations = 0;
  let finalText = "";

  while (iterations < maxIterations) {
    iterations++;

    const chatResult = await chat({
      correlationId,
      sessionId: req.sessionId,
      userId: req.userId,
      capability,
      messages,
      tools,
    });

    if (!chatResult.ok) {
      console.error(`[AGENT] LLM turn ${iterations} failed: ${chatResult.error.message}`);
      return {
        ok: false,
        text: finalText || "I encountered an error communicating with my AI brain.",
        correlationId,
        iterations,
        toolCalls: executedToolCalls,
        error: chatResult.error.message,
      };
    }

    if (chatResult.text) {
      finalText = chatResult.text;
    }

    const requestedToolCalls: ToolCall[] = chatResult.toolCalls ?? [];

    if (requestedToolCalls.length === 0) {
      // Reached final natural text response without requesting further tools
      messages.push({
        role: "assistant",
        content: finalText,
      });
      return {
        ok: true,
        text: finalText,
        correlationId,
        iterations,
        toolCalls: executedToolCalls,
      };
    }

    // Append assistant message indicating the tool calls
    messages.push({
      role: "assistant",
      content: chatResult.text ?? "",
    });

    // Execute each requested tool call
    for (const call of requestedToolCalls) {
      const toolDef = getTool(call.name);
      let toolResult: unknown;

      if (!toolDef || !toolDef.execute) {
        toolResult = { error: `Tool '${call.name}' is not registered or executable` };
      } else {
        try {
          const toolArgs = {
            ...(req.deviceId ? { device_id: req.deviceId } : {}),
            ...call.arguments,
          };
          toolResult = await toolDef.execute(toolArgs);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          toolResult = { error: errMsg };
        }
      }

      executedToolCalls.push({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        result: toolResult,
      });

      // Append tool result message for next turn
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
      });
    }
  }

  // If iteration loop cap was reached
  console.warn(`[AGENT] Reached max iteration limit of ${maxIterations}`);
  return {
    ok: true,
    text: finalText || "I completed the maximum allowed actions for this request.",
    correlationId,
    iterations,
    toolCalls: executedToolCalls,
  };
}
