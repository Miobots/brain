import type { ToolDefinition } from "../../ai/types.ts";
import type { MCPConnectionManager } from "./interfaces.ts";
import { MCPToolRegistry } from "./tool-registry.ts";
import type { MCPToolDefinition } from "./types.ts";

export function discoverMCPTools(
  registry: MCPToolRegistry,
  manager?: MCPConnectionManager,
  serverIds?: string[],
): MCPToolDefinition[] {
  if (manager) {
    const ids = new Set([
      ...registry.listAll().map((tool) => tool.serverId),
      ...manager.getReadyServers().map((server) => server.id),
      ...(serverIds ?? []),
    ]);
    for (const serverId of ids) {
      registry.refresh(manager.getAvailableTools(serverId), serverId);
      registry.updateServerStatus(serverId, manager.getStatus(serverId));
    }
  }

  const requestedServers = serverIds ? new Set(serverIds) : undefined;
  return registry.listAvailable()
    .filter((tool) => !requestedServers || requestedServers.has(tool.serverId))
    .map(({ available: _available, connectionStatus: _status, discoveredAt: _discoveredAt, updatedAt: _updatedAt, ...tool }) => tool);
}

export function toMCPModelTools(definitions: MCPToolDefinition[]): ToolDefinition[] {
  return definitions.map((tool) => ({
    name: tool.qualifiedName,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}