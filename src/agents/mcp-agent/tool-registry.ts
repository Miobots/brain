import type { MCPConnectionManager } from "./interfaces.ts";
import type { MCPConnectionStatus, MCPToolDefinition } from "./types.ts";

export interface RegisteredMCPTool extends MCPToolDefinition {
  available: boolean;
  connectionStatus: MCPConnectionStatus;
  discoveredAt: number;
  updatedAt: number;
}

export interface ToolRegistrySnapshot {
  tools: RegisteredMCPTool[];
  servers: Map<string, MCPConnectionStatus>;
}

export class MCPToolRegistry {
  private readonly tools = new Map<string, RegisteredMCPTool>();
  private readonly serverStatuses = new Map<string, MCPConnectionStatus>();
  private unsubscribe?: () => void;

  constructor(private readonly manager?: MCPConnectionManager) {
    if (manager) {
      this.unsubscribe = manager.onStateChange((serverId, status) => this.updateServerStatus(serverId, status));
      for (const server of manager.getReadyServers()) this.updateServerStatus(server.id, "ready");
      this.register(manager.getAvailableTools());
    }
  }

  register(definitions: MCPToolDefinition | MCPToolDefinition[]): RegisteredMCPTool[] {
    const values = Array.isArray(definitions) ? definitions : [definitions];
    const now = Date.now();
    return values.map((definition) => {
      const existing = this.tools.get(definition.qualifiedName);
      if (existing && existing.serverId !== definition.serverId) {
        throw new Error(`Tool identifier collision: ${definition.qualifiedName}`);
      }
      const registered: RegisteredMCPTool = {
        ...definition,
        inputSchema: cloneJson(definition.inputSchema),
        available: this.isServerAvailable(definition.serverId),
        connectionStatus: this.serverStatuses.get(definition.serverId) ?? "disconnected",
        discoveredAt: existing?.discoveredAt ?? now,
        updatedAt: now,
      };
      this.tools.set(registered.qualifiedName, registered);
      return { ...registered, inputSchema: cloneJson(registered.inputSchema) };
    });
  }

  update(definition: MCPToolDefinition): RegisteredMCPTool {
    return this.register(definition)[0]!;
  }

  remove(qualifiedName: string): boolean { return this.tools.delete(qualifiedName); }

  refresh(definitions: MCPToolDefinition[], serverId?: string): RegisteredMCPTool[] {
    const incoming = new Set(definitions.filter((tool) => !serverId || tool.serverId === serverId).map((tool) => tool.qualifiedName));
    if (serverId) {
      for (const [qualifiedName, tool] of this.tools) {
        if (tool.serverId === serverId && !incoming.has(qualifiedName)) this.tools.delete(qualifiedName);
      }
    }
    return this.register(definitions);
  }

  get(qualifiedName: string): RegisteredMCPTool | undefined {
    const tool = this.tools.get(qualifiedName);
    return tool ? { ...tool, inputSchema: cloneJson(tool.inputSchema) } : undefined;
  }

  listAvailable(): RegisteredMCPTool[] {
    return [...this.tools.values()].filter((tool) => tool.available).map((tool) => ({ ...tool, inputSchema: cloneJson(tool.inputSchema) }));
  }

  listAll(): RegisteredMCPTool[] {
    return [...this.tools.values()].map((tool) => ({ ...tool, inputSchema: cloneJson(tool.inputSchema) }));
  }

  updateServerStatus(serverId: string, status: MCPConnectionStatus): void {
    this.serverStatuses.set(serverId, status);
    const available = status === "ready" || status === "connected" || status === "degraded";
    for (const tool of this.tools.values()) {
      if (tool.serverId === serverId) {
        tool.connectionStatus = status;
        tool.available = available;
        tool.updatedAt = Date.now();
      }
    }
  }

  destroy(): void { this.unsubscribe?.(); }

  private isServerAvailable(serverId: string): boolean {
    if (!this.manager && !this.serverStatuses.has(serverId)) return true;
    const status = this.serverStatuses.get(serverId) ?? this.manager?.getStatus(serverId) ?? "disconnected";
    return status === "ready" || status === "connected" || status === "degraded";
  }
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
