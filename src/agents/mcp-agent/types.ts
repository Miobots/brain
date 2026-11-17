import type {
  Attachment,
  ChatMessage,
  JsonSchema,
} from "../../ai/types.ts";
import type { WebSocket } from "ws";

export type MCPTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_tool"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskBudget {
  maxIterations: number;
  maxModelCalls: number;
  maxMcpCalls: number;
  maxExecutionTimeMs: number;
  maxConcurrentCalls: number;
  maxOutputBytes: number;
}

export type MCPModelRole = "orchestrator" | "vision" | "fast" | "reasoning";

export interface ArtifactReference {
  artifactId: string;
  mediaType?: string;
  filename?: string;
  sizeBytes?: number;
  uri?: string;
}

export type OutputBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: Attachment | ArtifactReference; mediaType?: string }
  | { type: "audio"; source: Attachment | ArtifactReference; mediaType?: string }
  | { type: "file"; source: Attachment | ArtifactReference; mediaType?: string; filename?: string }
  | { type: "json"; value: unknown }
  | { type: "resource"; resource: ArtifactReference };

export interface MCPServerInfo {
  id: string;
  name: string;
  protocolVersion?: string;
  version?: string;
  capabilities?: readonly string[];
  metadata?: Record<string, unknown>;
}

export type MCPConnectionStatus =
  | "disconnected"
  | "connecting"
  | "initializing"
  | "ready"
  | "reconnecting"
  | "closing"
  | "connected"
  | "degraded"
  | "failed";

export type MCPToolPermission = "read" | "action";

export interface MCPToolDefinition {
  name: string;
  originalName?: string;
  qualifiedName: string;
  serverId: string;
  description: string;
  inputSchema: JsonSchema;
  permission?: MCPToolPermission;
  metadata?: Record<string, unknown>;
}

export interface MCPToolCall {
  id: string;
  toolName: string;
  serverId: string;
  arguments: Record<string, unknown>;
}

export interface MCPCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface MCPAuthenticatedPeer {
  deviceId: string;
  socket: WebSocket;
  generation: number;
}

export type MCPNotification =
  | { method: "notifications/tools/list_changed" }
  | { method: "notifications/resources/list_changed" }
  | { method: "notifications/progress"; params?: Record<string, unknown> }
  | { method: string; params?: Record<string, unknown> };

export interface MCPToolExecutionResult {
  ok: boolean;
  output: OutputBlock[];
  isError?: boolean;
  error?: AgentError;
  metadata?: Record<string, unknown>;
}

export interface MCPAgentRequest {
  instruction: string;
  taskId?: string;
  correlationId?: string;
  sessionId?: string;
  userId?: string;
  messages?: ChatMessage[];
  serverIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface MCPAgentRunOptions {
  budget?: Partial<TaskBudget>;
  modelRole?: MCPModelRole;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface MCPAgentResult {
  taskId: string;
  status: MCPTaskStatus;
  output: OutputBlock[];
  toolCalls: MCPToolCall[];
  errors: AgentError[];
  iterations: number;
  modelCalls: number;
  mcpCalls: number;
  artifacts: ArtifactReference[];
  startedAt: number;
  completedAt?: number;
}

export interface MCPTaskSnapshot {
  taskId: string;
  request: MCPAgentRequest;
  status: MCPTaskStatus;
  result?: MCPAgentResult;
  events: MCPAgentEvent[];
  budget: TaskBudget;
  createdAt: number;
  updatedAt: number;
}

export type MCPAgentEvent =
  | { type: "task_started"; taskId: string; timestamp: number }
  | { type: "status_changed"; taskId: string; timestamp: number; status: MCPTaskStatus }
  | { type: "model_called"; taskId: string; timestamp: number; role: MCPModelRole }
  | { type: "tool_called"; taskId: string; timestamp: number; call: MCPToolCall }
  | { type: "tool_result"; taskId: string; timestamp: number; callId: string; result: MCPToolExecutionResult }
  | { type: "progress"; taskId: string; timestamp: number; message: string }
  | { type: "artifact_created"; taskId: string; timestamp: number; artifact: ArtifactReference }
  | { type: "error"; taskId: string; timestamp: number; error: AgentError }
  | { type: "completed"; taskId: string; timestamp: number; result: MCPAgentResult };

export interface MCPModelRequest {
  role: MCPModelRole;
  messages: ChatMessage[];
  tools?: MCPToolDefinition[];
  correlationId: string;
  sessionId?: string;
  userId?: string;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface MCPModelResponse {
  output: OutputBlock[];
  toolCalls: MCPToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "error" | "unknown";
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AgentError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface MCPResourceDefinition {
  uri: string;
  name?: string;
  description?: string;
  mediaType?: string;
  serverId: string;
  metadata?: Record<string, unknown>;
}

export interface MCPResourceListEntry {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}