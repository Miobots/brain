import { createAck, encode, Kind, type Envelope } from "@miobots/protocol";
import { config } from "../../brain/config.ts";
import type { MCPConnectionManager, MCPSession } from "./interfaces.ts";
import { MCPSessionImpl, MCPTransport } from "./transport.ts";
import type {
  MCPAuthenticatedPeer,
  MCPConnectionStatus,
  MCPServerInfo,
} from "./types.ts";

type Entry = {
  peer: MCPAuthenticatedPeer;
  session: MCPSessionImpl;
  transport: MCPTransport;
  status: MCPConnectionStatus;
  info?: MCPServerInfo;
};

export class MCPConnectionManagerImpl implements MCPConnectionManager {
  private readonly entries = new Map<string, Entry>();

  async attach(peer: MCPAuthenticatedPeer): Promise<MCPSession> {
    if (!config.mcpAllowedGanglionDeviceIds.includes(peer.deviceId)) {
      throw new Error("MCP server is not allowlisted");
    }

    const existing = this.entries.get(peer.deviceId);
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
    const entry: Entry = { peer, session, transport, status: "connecting" };
    this.entries.set(peer.deviceId, entry);

    try {
      entry.info = await session.initialize();
      if (this.entries.get(peer.deviceId) !== entry) throw new Error("MCP connection was replaced during initialization");
      entry.status = "ready";
      return session;
    } catch (error) {
      if (this.entries.get(peer.deviceId) === entry) {
        entry.status = "failed";
      }
      session.close("MCP initialization failed");
      throw error;
    }
  }

  async detach(peer: MCPAuthenticatedPeer): Promise<void> {
    const entry = this.entries.get(peer.deviceId);
    if (!entry || entry.peer.socket !== peer.socket || entry.peer.generation !== peer.generation) return;
    entry.status = "disconnected";
    entry.session.close("MCP server disconnected");
    this.entries.delete(peer.deviceId);
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
    return entry?.status === "ready" ? entry.session : undefined;
  }

  handleEnvelope(peer: MCPAuthenticatedPeer, envelope: Envelope<string, unknown>): boolean {
    const entry = this.entries.get(peer.deviceId);
    if (!entry || entry.peer.socket !== peer.socket || entry.peer.generation !== peer.generation) return false;
    if (envelope.kind === Kind.EVT && envelope.topic === "mcp.response") return entry.transport.receiveResponse(envelope);
    if (envelope.kind === Kind.EVT && envelope.topic === "mcp.notification") return entry.transport.receiveNotification(envelope);
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
    for (const entry of this.entries.values()) entry.session.close("MCP manager closed");
    this.entries.clear();
  }
}

export const mcpConnectionManager = new MCPConnectionManagerImpl();