import type { ChatMessage } from "../../ai/types.ts";
import type { MCPAgentRequest } from "./types.ts";

export const MCP_AGENT_SYSTEM_PROMPT =
  "You are the MCP Agent. Use only the connected MCP tools provided for this task. " +
  "Never claim a tool action succeeded when its result reports an error. " +
  "Report unavailable tools and execution failures clearly. Do not expose hidden reasoning.";

export function createMCPConversation(request: MCPAgentRequest): ChatMessage[] {
  return [
    { role: "system", content: MCP_AGENT_SYSTEM_PROMPT },
    ...(request.messages ?? []).map(copyMessage),
    { role: "user", content: request.instruction },
  ];
}

export function appendAssistantToolCalls(
  messages: ChatMessage[],
  content: string,
  toolCalls: NonNullable<ChatMessage["toolCalls"]>,
): void {
  messages.push({ role: "assistant", content, toolCalls });
}

export function appendToolResult(
  messages: ChatMessage[],
  toolCallId: string,
  name: string,
  content: string,
  attachments: NonNullable<ChatMessage["attachments"]>,
): void {
  messages.push({ role: "tool", toolCallId, name, content, ...(attachments.length ? { attachments } : {}) });
}

function copyMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    ...(message.attachments
      ? { attachments: message.attachments.map((attachment) => ({ ...attachment, source: { ...attachment.source } })) }
      : {}),
    ...(message.toolCalls
      ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: { ...call.arguments } })) }
      : {}),
  };
}