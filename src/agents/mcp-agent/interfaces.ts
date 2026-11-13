import type {
  MCPAgentRequest,
  MCPAgentResult,
  MCPAgentRunOptions,
  MCPConnectionStatus,
  MCPAuthenticatedPeer,
  MCPServerInfo,
  MCPTaskSnapshot,
  MCPToolCall,
  MCPToolDefinition,
  MCPToolExecutionResult,
  MCPModelRequest,
  MCPModelResponse,
  MCPResourceDefinition,
  MCPCallOptions,
  MCPNotification,
} from "./types.ts";
import type { JsonRpcResponse } from "@miobots/protocol";

export interface MCPAgent {
  run(request: MCPAgentRequest, options?: MCPAgentRunOptions): Promise<MCPAgentResult>;
  cancel(taskId: string): Promise<void>;
  getTask(taskId: string): MCPTaskSnapshot | undefined;
}

export interface MCPAgentLoop {
  execute(request: MCPAgentRequest, options?: MCPAgentRunOptions): Promise<MCPAgentResult>;
}

export interface MCPConnectionManager {
  attach(peer: MCPAuthenticatedPeer): Promise<MCPSession>;
  detach(peer: MCPAuthenticatedPeer): Promise<void>;
  getStatus(serverId: string): MCPConnectionStatus;
  getReadyServers(): MCPServerInfo[];
  getSession(serverId: string): MCPSession | undefined;
  request(serverId: string, method: string, params?: Record<string, unknown> | unknown[], options?: MCPCallOptions): Promise<JsonRpcResponse>;
  getAvailableTools(serverId?: string): MCPToolDefinition[];
  getTool(qualifiedName: string): MCPToolDefinition | undefined;
  refresh(serverId?: string): Promise<MCPToolDefinition[]>;
  onStateChange(listener: (serverId: string, status: MCPConnectionStatus) => void): () => void;
}

export interface MCPSession {
  listTools(): Promise<MCPToolDefinition[]>;
  listResources(): Promise<MCPResourceDefinition[]>;
  callTool(call: MCPToolCall, options?: MCPCallOptions): Promise<MCPToolExecutionResult>;
  addNotificationListener(listener: (notification: MCPNotification) => void): () => void;
}

export interface MCPToolRegistry {
  discover(sessions: Iterable<MCPSession>): Promise<MCPToolDefinition[]>;
  getAvailableTools(): MCPToolDefinition[];
  getTool(qualifiedName: string): MCPToolDefinition | undefined;
  refresh(serverId?: string): Promise<MCPToolDefinition[]>;
}

export interface MCPToolExecutor {
  execute(call: MCPToolCall): Promise<MCPToolExecutionResult>;
}

export interface MCPModelGateway {
  invoke(request: MCPModelRequest): Promise<MCPModelResponse>;
}