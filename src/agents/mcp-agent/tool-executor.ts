import type { MCPConnectionManager } from "./interfaces.ts";
import type { MCPCallOptions, MCPToolExecutionResult } from "./types.ts";
import { MCPToolRegistry, type RegisteredMCPTool } from "./tool-registry.ts";
import { validateToolArguments, type ToolValidationError } from "./tool-validation.ts";

export interface MCPToolPermissionRequest {
  tool: RegisteredMCPTool;
  arguments: Record<string, unknown>;
  operation?: string;
  target?: string;
}

export interface MCPToolPermissionProvider {
  authorize(request: MCPToolPermissionRequest): Promise<
    | { allowed: true }
    | { allowed: false; code?: "permission_denied" | "approval_required" | "approval_rejected"; message?: string }
  >;
}

export interface MCPToolExecutorOptions {
  permissionProvider?: MCPToolPermissionProvider;
  defaultTimeoutMs?: number;
}

export class MCPToolExecutor {
  private readonly inFlightActions = new Map<string, Promise<unknown>>();
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly registry: MCPToolRegistry,
    private readonly manager: MCPConnectionManager,
    private readonly options: MCPToolExecutorOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  async execute(
    qualifiedName: string,
    argumentsValue: Record<string, unknown>,
    options: MCPCallOptions & { operation?: string; target?: string } = {},
  ): Promise<MCPToolExecutionResult> {
    const tool = this.registry.get(qualifiedName);
    if (!tool) return failure("unknown_tool", "MCP tool is not registered");
    if (!tool.available) return failure("server_unavailable", "MCP tool server is unavailable");
    if (tool.permission !== "read" && tool.permission !== "action") {
      return failure("permission_unknown", "MCP tool permission is unknown");
    }

    const permission = await this.options.permissionProvider?.authorize({
      tool,
      arguments: argumentsValue,
      operation: options.operation,
      target: options.target,
    }) ?? { allowed: false, code: "approval_required", message: "MCP tool permission is not configured" };
    if (!permission.allowed) return failure(permission.code ?? "permission_denied", permission.message ?? "MCP tool permission denied");

    const validation = validateToolArguments(tool.inputSchema, argumentsValue);
    if (!validation.ok) return failure(validation.error.code, validation.error.message, validation.error);

    const session = this.manager.getSession(tool.serverId);
    if (!session) return failure("server_unavailable", "MCP server session is unavailable");

    const callOptions: MCPCallOptions = {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
    };
    const invoke = () => session.callTool({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      toolName: tool.qualifiedName,
      serverId: tool.serverId,
      arguments: argumentsValue,
    }, callOptions);

    const execution = tool.permission === "action"
      ? this.serializeAction(tool.serverId, invoke)
      : invoke();
    try {
      return await execution;
    } catch (error) {
      if (options.signal?.aborted) return failure("cancelled", "MCP tool execution was cancelled");
      if (error instanceof Error && error.message.toLowerCase().includes("timed out")) return failure("timeout", "MCP tool execution timed out");
      return failure("remote_execution_failed", "MCP tool execution failed");
    }
  }

  private serializeAction<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.inFlightActions.get(key) ?? Promise.resolve();
    const current = prior.then(operation, operation);
    this.inFlightActions.set(key, current);
    void current.finally(() => {
      if (this.inFlightActions.get(key) === current) this.inFlightActions.delete(key);
    }).catch(() => undefined);
    return current;
  }
}

function failure(code: string, message: string, details?: ToolValidationError): MCPToolExecutionResult {
  return { ok: false, isError: true, output: [], error: { code, message, ...(details ? { details: { path: details.path } } : {}) } };
}
