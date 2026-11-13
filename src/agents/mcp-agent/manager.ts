import { createAck, encode, Kind, type Envelope, type JsonRpcResponse } from "@miobots/protocol";
import { config } from "../../brain/config.ts";
import type { MCPConnectionManager, MCPSession } from "./interfaces.ts";
import { MCPSessionImpl, MCPTransport } from "./transport.ts";
import type {
  MCPAuthenticatedPeer,
  MCPConnectionStatus,
  MCPServerInfo,
  MCPCallOptions,
  MCPToolDefinition,
} from "./types.ts";

type Entry = {
  peer: MCPAuthenticatedPeer;
  session: MCPSessionImpl;
  transport: MCPTransport;
  status: MCPConnectionStatus;
  info?: MCPServerInfo;
  tools: MCPToolDefinition[];
  initialization?: Promise<MCPSession>;
};

export class MCPConnectionManagerImpl implements MCPConnectionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly stateListeners = new Set<(serverId: string, status: MCPConnectionStatus) => void>();
  private readonly toolCatalog = new Map<string, MCPToolDefinition[]>();

  async attach(peer: MCPAuthenticatedPeer): Promise<MCPSession> {
    if (!config.mcpAllowedGanglionDeviceIds.includes(peer.deviceId)) {
      throw new Error("MCP server is not allowlisted");
    }

    const existing = this.entries.get(peer.deviceId);
    if (existing && existing.peer.socket === peer.socket && existing.peer.generation === peer.generation) {
      if (existing.initialization) return existing.initialization;
      if (existing.status === "ready" || existing.status === "degraded") return existing.session;
    }
    if (existing && existing.peer.socket !== peer.socket) {
      await this.detach(existing.peer);
    }

    const transport = new MCPTransport(peer, {
      requestTimeoutMs: config.mcp_request_timeout_ms,
      maxPending: config.mcp_max_pending_requests,
      rateLimitPerSecond: config.mcp_rate_limit_per_second,
      highWaterMarkBytes: config.mcp_outbound_high_water_mark,
    });
    const session = new MCPSessionImpl(peer, transport);
    transport.setNotificationHandler((notification) => session.handleNotification(notification));
    const entry: Entry = { peer, session, transport, status: "connecting", tools: [] };
    this.entries.set(peer.deviceId, entry);
    this.emitState(peer.deviceId, "connecting");

    entry.initialization = (async () => {
      this.setStatus(entry, "initializing");
      entry.info = await session.initialize();
      if (this.entries.get(peer.deviceId) !== entry) throw new Error("MCP connection was replaced during initialization");
      let discoverySucceeded = true;
      try {
        entry.tools = await session.listTools();
        this.toolCatalog.set(peer.deviceId, entry.tools);
      } catch (error) {
        discoverySucceeded = false;
        this.setStatus(entry, "degraded");
        console.warn(`[MCP] Tool discovery failed server=${peer.deviceId}: ${error instanceof Error ? error.message : "unknown"}`);
      }
      if (discoverySucceeded) this.setStatus(entry, "ready");
      return session;
    })();
    try {
      return await entry.initialization;
    } catch (error) {
      if (this.entries.get(peer.deviceId) === entry) {
        this.setStatus(entry, "failed");
      }
      session.close("MCP initialization failed");
      throw error;
    }
  }

  async detach(peer: MCPAuthenticatedPeer): Promise<void> {
    const entry = this.entries.get(peer.deviceId);
    if (!entry || entry.peer.socket !== peer.socket || entry.peer.generation !== peer.generation) return;
    this.setStatus(entry, "closing");
    entry.session.close("MCP server disconnected");
    this.entries.delete(peer.deviceId);
    this.toolCatalog.delete(peer.deviceId);
    this.emitState(peer.deviceId, "disconnected");
  }

  getStatus(serverId: string): MCPConnectionStatus {
    return this.entries.get(serverId)?.status ?? "disconnected";
  }

  getReadyServers(): MCPServerInfo[] {
    return [...this.entries.values()]
      .filter((entry) => entry.status === "ready" && entry.info)
      .map((entry) => entry.info!);
  }

  getSession(serverId: string): MCPSession | undefined {
    const entry = this.entries.get(serverId);
    return entry && (entry.status === "ready" || entry.status === "degraded") ? entry.session : undefined;
  }

  async request(serverId: string, method: string, params?: Record<string, unknown> | unknown[], options?: MCPCallOptions): Promise<JsonRpcResponse> {
    const entry = this.entries.get(serverId);
    if (!entry || (entry.status !== "ready" && entry.status !== "degraded")) throw new Error(`MCP server '${serverId}' is not ready`);
    return entry.transport.request(method, params, options);
  }

  getAvailableTools(serverId?: string): MCPToolDefinition[] {
    if (serverId) return [...(this.toolCatalog.get(serverId) ?? [])];
    return [...this.toolCatalog.values()].flat().map((tool) => ({ ...tool }));
  }

  getTool(qualifiedName: string): MCPToolDefinition | undefined {
    return this.getAvailableTools().find((tool) => tool.qualifiedName === qualifiedName);
  }

  async refresh(serverId?: string): Promise<MCPToolDefinition[]> {
    const ids = serverId ? [serverId] : [...this.entries.keys()];
    const refreshed: MCPToolDefinition[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry || (entry.status !== "ready" && entry.status !== "degraded")) continue;
      entry.tools = await entry.session.listTools();
      this.toolCatalog.set(id, entry.tools);
      refreshed.push(...entry.tools);
    }
    return refreshed;
  }

  onStateChange(listener: (serverId: string, status: MCPConnectionStatus) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  handleEnvelope(peer: MCPAuthenticatedPeer, envelope: Envelope<string, unknown>): boolean {
    const entry = this.entries.get(peer.deviceId);
    if (!entry || entry.peer.socket !== peer.socket || entry.peer.generation !== peer.generation) return false;
    if (envelope.kind === Kind.EVT && envelope.topic === "mcp.response") return entry.transport.receiveResponse(envelope);
    if (envelope.kind === Kind.EVT && envelope.topic === "mcp.notification") {
      const handled = entry.transport.receiveNotification(envelope);
      if (handled && (envelope.payload as { method?: string }).method === "notifications/tools/list_changed") {
        void this.refresh(peer.deviceId).catch((error: unknown) => {
          this.setStatus(entry, "degraded");
          console.warn(`[MCP] Tool refresh failed server=${peer.deviceId}: ${error instanceof Error ? error.message : "unknown"}`);
        });
      }
      return handled;
    }
    return false;
  }

  rejectServerRequest(peer: MCPAuthenticatedPeer, envelope: Envelope<string, unknown>, outboundSeq: number): void {
    if (peer.socket.readyState !== peer.socket.OPEN) return;
    peer.socket.send(encode(createAck(envelope, {
      accepted: false,
      reason: "server_initiated_mcp_requests_unsupported",
    }, outboundSeq)));
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      this.setStatus(entry, "closing");
      entry.session.close("MCP manager closed");
    }
    this.entries.clear();
    this.toolCatalog.clear();
  }

  private setStatus(entry: Entry, status: MCPConnectionStatus): void {
    entry.status = status;
    this.emitState(entry.peer.deviceId, status);
  }

  private emitState(serverId: string, status: MCPConnectionStatus): void {
    for (const listener of this.stateListeners) listener(serverId, status);
  }
}

export const mcpConnectionManager = new MCPConnectionManagerImpl();