import { randomUUID } from "node:crypto";
import { chat as sharedChat } from "../../ai/client.ts";
import type { ChatMessage, ChatResult, ToolCall } from "../../ai/types.ts";
import type { MCPAgentLoop as MCPAgentLoopContract, MCPConnectionManager } from "./interfaces.ts";
import { appendAssistantToolCalls, appendToolResult, createMCPConversation } from "./context.ts";
import { MCPToolExecutor } from "./tool-executor.ts";
import { MCPToolRegistry } from "./tool-registry.ts";
import { collectArtifacts, createToolObservation, modelOutput, normalizeToolResult } from "./outputs.ts";
import { discoverMCPTools, toMCPModelTools } from "./tools.ts";
import type {
  AgentError,
  MCPAgentRequest,
  MCPAgentResult,
  MCPAgentRunOptions,
  MCPToolCall,
  MCPToolExecutionResult,
  OutputBlock,
} from "./types.ts";

export const DEFAULT_MCP_AGENT_MAX_ITERATIONS = 5;

export interface MCPAgentDependencies {
  registry: MCPToolRegistry;
  executor: MCPToolExecutor;
  manager?: MCPConnectionManager;
  chat?: typeof sharedChat;
}

export async function runMCPAgent(
  request: MCPAgentRequest,
  dependencies: MCPAgentDependencies,
  options: MCPAgentRunOptions = {},
): Promise<MCPAgentResult> {
  const startedAt = Date.now();
  const taskId = request.taskId ?? randomUUID();
  const correlationId = request.correlationId ?? randomUUID();
  const sessionId = request.sessionId ?? taskId;
  const maxIterations = getMaxIterations(options.budget?.maxIterations);
  const conversation = createMCPConversation(request);
  const definitions = discoverMCPTools(dependencies.registry, dependencies.manager, request.serverIds);
  const tools = toMCPModelTools(definitions);
  const chat = dependencies.chat ?? sharedChat;
  const executedCalls: MCPToolCall[] = [];
  const errors: AgentError[] = [];
  const artifacts: MCPAgentResult["artifacts"] = [];
  let finalOutput: OutputBlock[] = [];
  let iterations = 0;
  let mcpCalls = 0;
  let visionRequired = conversation.some((message) =>
    message.attachments?.some((attachment) => attachment.mediaType?.startsWith("image/")) ?? false,
  );

  while (iterations < maxIterations) {
    iterations++;
    let response: ChatResult;
    try {
      response = await chat({
        correlationId,
        sessionId,
        userId: request.userId,
        capability: visionRequired ? "vision" : options.modelRole ?? "orchestrator",
        messages: [...conversation],
        tools,
        includeBuiltinTools: false,
        metadata: { ...request.metadata, ...options.metadata, taskId },
      });
    } catch (error) {
      const failure = toAgentError("model_failure", error);
      errors.push(failure);
      finalOutput = [{ type: "text", text: failure.message }];
      return finish("failed");
    }

    if (!response.ok) {
      errors.push({ code: response.error.code, message: response.error.message });
      finalOutput = [{ type: "text", text: `MCP Agent model request failed: ${response.error.message}` }];
      return finish("failed");
    }

    const modelText = response.text ?? "";
    const requestedCalls = response.toolCalls ?? [];
    if (requestedCalls.length === 0) {
      finalOutput = modelOutput(response);
      if (finalOutput.length === 0) {
        const failure = { code: "empty_model_response", message: "The model returned neither text nor output files." };
        errors.push(failure);
        finalOutput = [{ type: "text", text: failure.message }];
        return finish("failed");
      }
      conversation.push({ role: "assistant", content: modelText });
      return finish(errors.length ? "failed" : "completed");
    }

    appendAssistantToolCalls(conversation, modelText, requestedCalls);
    const followUpAttachments: NonNullable<ChatMessage["attachments"]> = [];
    const mediaToolNames: string[] = [];
    for (const requestedCall of requestedCalls) {
      const definition = definitions.find((tool) => tool.qualifiedName === requestedCall.name);
      const toolCall: MCPToolCall = {
        id: requestedCall.id,
        toolName: requestedCall.name,
        serverId: definition?.serverId ?? serverIdFromName(requestedCall.name),
        arguments: isRecord(requestedCall.arguments) ? requestedCall.arguments : {},
      };
      executedCalls.push(toolCall);

      let rawResult: unknown;
      if (requestedCall.result !== undefined) {
        rawResult = requestedCall.result;
      } else if (!definition) {
        rawResult = failedExecution("unknown_tool", `MCP tool '${requestedCall.name}' is not registered or available.`);
      } else if (!isRecord(requestedCall.arguments)) {
        rawResult = failedExecution("invalid_arguments", `Arguments for MCP tool '${requestedCall.name}' must be an object.`);
      } else {
        mcpCalls++;
        try {
          rawResult = await dependencies.executor.execute(definition.qualifiedName, requestedCall.arguments, {
            signal: options.signal,
          });
        } catch (error) {
          rawResult = failedExecution("execution_failed", error instanceof Error ? error.message : String(error));
        }
      }

      const execution = normalizeToolResult(rawResult);
      const observation = createToolObservation(execution);
      if (!execution.ok) {
        const failure = observation.error ?? { code: "execution_failed", message: "MCP tool execution failed." };
        errors.push({ ...failure, details: { toolName: requestedCall.name, callId: requestedCall.id } });
      }
      artifacts.push(...collectArtifacts(observation.output));
      appendToolResult(
        conversation,
        requestedCall.id,
        requestedCall.name,
        observation.content,
        [],
      );
      if (observation.attachments.some((attachment) => attachment.mediaType?.startsWith("image/"))) {
        visionRequired = true;
      }
      if (observation.attachments.length > 0) {
        followUpAttachments.push(...observation.attachments);
        mediaToolNames.push(requestedCall.name);
      }
    }
    if (followUpAttachments.length > 0) {
      conversation.push({
        role: "user",
        content: `MCP tool output from ${mediaToolNames.join(", ")} is attached. Use it as evidence when answering the request.`,
        attachments: followUpAttachments,
      });
    }
  }

  const limitError = { code: "max_iterations", message: `Reached MCP Agent iteration limit of ${maxIterations}.` };
  errors.push(limitError);
  finalOutput = [{ type: "text", text: limitError.message }];
  return finish("failed");

  function finish(status: MCPAgentResult["status"]): MCPAgentResult {
    return {
      taskId,
      status,
      output: finalOutput,
      toolCalls: executedCalls,
      errors,
      iterations,
      modelCalls: iterations,
      mcpCalls,
      artifacts,
      startedAt,
      completedAt: Date.now(),
    };
  }
}

export class MCPAgentRunner implements MCPAgentLoopContract {
  constructor(private readonly dependencies: MCPAgentDependencies) {}

  execute(request: MCPAgentRequest, options?: MCPAgentRunOptions): Promise<MCPAgentResult> {
    return runMCPAgent(request, this.dependencies, options);
  }
}

function getMaxIterations(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : DEFAULT_MCP_AGENT_MAX_ITERATIONS;
}

function failedExecution(code: string, message: string): MCPToolExecutionResult {
  return { ok: false, isError: true, output: [], error: { code, message } };
}

function toAgentError(code: string, error: unknown): AgentError {
  return { code, message: error instanceof Error ? error.message : String(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serverIdFromName(name: string): string {
  return name.startsWith("mcp__") ? name.slice(5).split("__", 1)[0] || "unknown" : "unknown";
}