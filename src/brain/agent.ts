import { randomUUID } from "node:crypto";
import { chat } from "../ai/client.ts";
import type { ChatMessage, ToolCall, ToolDefinition } from "../ai/types.ts";
import { getTools } from "./tools.ts";

export const DEFAULT_MAX_ITERATIONS = 5;

export const SYSTEM_PROMPT =
  "You are Mio, an intelligent and friendly companion robot assistant. " +
  "You interact with users naturally and speak aloud or perform physical robot actions using your registered tools. " +
  "When the user asks you to say, speak, or greet someone in English or Urdu, invoke the speak tool with the requested text and appropriate language code ('en' or 'ur'). " +
  "When the user asks the robot to go somewhere, invoke navigate_to; it returns a goal ID immediately while progress continues. " +
  "If the user asks to stop an active drive, invoke cancel_navigation; include a goal ID when known, otherwise omit it to cancel the active drive. " +
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
  // The cap is a safety limit: callers may lower it, never raise it or switch the model off.
  const maxIterations = Math.min(
    Math.max(1, Math.floor(req.maxIterations ?? DEFAULT_MAX_ITERATIONS) || 1),
    DEFAULT_MAX_ITERATIONS,
  );
  const capability = req.capability ?? "fast";
  const systemPrompt = req.systemPrompt ?? SYSTEM_PROMPT;
  const tools = req.tools ?? getTools();
  // The model sees schemas only. Execution happens once, below, so a physical command is never
  // sent twice (once by the SDK, once by this loop).
  const modelTools: ToolDefinition[] = tools.map(({ execute: _execute, ...schema }) => schema);

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
      tools: modelTools,
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

    // Providers reject tool results that are not preceded by the assistant turn requesting them.
    messages.push({
      role: "assistant",
      content: chatResult.text ?? "",
      toolCalls: requestedToolCalls,
    });

    // Execute each requested tool call
    for (const call of requestedToolCalls) {
      // Resolve from this request's tool set, not the global registry, so the allow-list holds.
      const toolDef = tools.find((t) => t.name === call.name);
      let toolResult: unknown;

      if (call.result !== undefined) {
        // A built-in tool the AI client executed itself; record it, don't run it again.
        toolResult = call.result;
      } else if (!toolDef || !toolDef.execute) {
        toolResult = { error: `Tool '${call.name}' is not registered or executable` };
      } else {
        try {
          // The request's device wins over anything the model put in the arguments.
          const toolArgs = {
            ...call.arguments,
            ...(req.deviceId ? { device_id: req.deviceId } : {}),
          };
          toolResult = await toolDef.execute(toolArgs);
        } catch (err: unknown) {
          // A Heart refusal or timeout is a physical failure: stop and say so, rather than let
          // the next model turn paper over it with a cheerful sentence.
          const errMsg = err instanceof Error ? err.message : String(err);
          const userFacingError = isUserFacingError(err);
          const userMessage = userFacingError ? err.userMessage : `I couldn't do that: ${errMsg}`;
          executedToolCalls.push({ id: call.id, name: call.name, arguments: call.arguments, result: { error: errMsg } });
          return {
            ok: userFacingError,
            text: userMessage,
            correlationId,
            iterations,
            toolCalls: executedToolCalls,
            ...(userFacingError ? {} : { error: errMsg }),
          };
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
    ok: false,
    text: "I ran out of steps before finishing that request.",
    correlationId,
    iterations,
    toolCalls: executedToolCalls,
    error: `Reached max iteration limit of ${maxIterations}`,
  };
}

function isUserFacingError(error: unknown): error is Error & { userMessage: string } {
  return error instanceof Error
    && "userMessage" in error
    && typeof error.userMessage === "string";
}
