import type {
  MCPAgentRequest,
  MCPAgentResult,
  MCPAgentRunOptions,
  MCPConnectionStatus,
  MCPServerInfo,
  MCPTaskSnapshot,
  MCPToolCall,
  MCPToolDefinition,
  MCPToolExecutionResult,
  MCPModelRequest,
  MCPModelResponse,
  MCPResourceDefinition,
} from "./types.ts";

export interface MCPAgent {
  run(request: MCPAgentRequest, options?: MCPAgentRunOptions): Promise<MCPAgentResult>;
  cancel(taskId: string): Promise<void>;
  getTask(taskId: string): MCPTaskSnapshot | undefined;
}

export interface MCPAgentLoop {
  execute(request: MCPAgentRequest, options?: MCPAgentRunOptions): Promise<MCPAgentResult>;
}

export interface MCPConnectionManager {
  connect(server: MCPServerInfo): Promise<MCPSession>;
  disconnect(serverId: string): Promise<void>;
  getStatus(serverId: string): MCPConnectionStatus;
  getReadyServers(): MCPServerInfo[];
  getSession(serverId: string): MCPSession | undefined;
}

export interface MCPSession {
  listTools(): Promise<MCPToolDefinition[]>;
  listResources(): Promise<MCPResourceDefinition[]>;
  callTool(call: MCPToolCall): Promise<MCPToolExecutionResult>;
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