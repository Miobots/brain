import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  Kind,
  Topics,
  type Envelope,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type MCPNotificationPayload,
  type MCPRequestPayload,
  type MCPResponsePayload,
  validateMCPNotification,
  validateMCPResponse,
} from "@miobots/protocol";
import { sendCommandHandle, type CommandHandle } from "../../brain/hub.ts";
import type {
  MCPAgentEvent,
  MCPAuthenticatedPeer,
  MCPCallOptions,
  MCPConnectionStatus,
  MCPNotification,
  MCPResourceDefinition,
  MCPServerInfo,
  MCPToolCall,
  MCPToolDefinition,
  MCPToolExecutionResult,
} from "./types.ts";
import type { MCPSession } from "./interfaces.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "miobots-brain";
const CLIENT_VERSION = "0.1.0";
const HIGH_WATER_MARK_BYTES = 512 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING = 16;
const DEFAULT_RATE_LIMIT = 32;
const MAX_PAGES = 64;

type PendingResponse = {
  rpcId: string;
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class MCPTransport {
  private readonly pending = new Map<string, PendingResponse>();
  private readonly requestTimes: number[] = [];
  private nextRpcId = 1;

  constructor(
    private readonly peer: MCPAuthenticatedPeer,
    private readonly options: {
      requestTimeoutMs?: number;
      maxPending?: number;
      rateLimitPerSecond?: number;
      highWaterMarkBytes?: number;
      onNotification?: (notification: MCPNotification) => void;
    } = {},
  ) {}

  setNotificationHandler(handler: (notification: MCPNotification) => void): void {
    this.options.onNotification = handler;
  }

  async request(method: string, params?: Record<string, unknown> | unknown[], options?: MCPCallOptions): Promise<JsonRpcResponse> {
    if (this.pending.size >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) {
      throw new Error("MCP request limit reached");
    }
    const now = Date.now();
    const rateWindow = now - 1_000;
    while (this.requestTimes[0] !== undefined && this.requestTimes[0] < rateWindow) this.requestTimes.shift();
    if (this.requestTimes.length >= (this.options.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT)) {
      throw new Error("MCP request rate limit reached");
    }
    if (this.peer.socket.readyState !== this.peer.socket.OPEN) throw new Error("MCP connection is not ready");
    if (this.peer.socket.bufferedAmount > (this.options.highWaterMarkBytes ?? HIGH_WATER_MARK_BYTES)) throw new Error("MCP connection backpressure limit reached");

    const rpcId = String(this.nextRpcId++);
    const payload: MCPRequestPayload = {
      jsonrpc: "2.0",
      id: rpcId,
      method,
      ...(params === undefined ? {} : { params: params as MCPRequestPayload["params"] }),
    };
    let correlationId = "";
    let responsePromise!: Promise<JsonRpcResponse>;
    const handle = sendCommandHandle(
      this.peer.deviceId,
      Topics.MCP_REQUEST,
      payload,
      undefined,
      undefined,
      {
        rejectOnNack: true,
        beforeSend: (corrId) => {
          correlationId = corrId;
          responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
              this.pending.delete(corrId);
              reject(new Error(`MCP request timed out: ${method}`));
              void this.sendNotification("notifications/cancelled", { requestId: rpcId }).catch(() => undefined);
            }, options?.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
            this.pending.set(corrId, { rpcId, resolve, reject, timer });
          });
          void responsePromise.catch(() => undefined);
          this.requestTimes.push(Date.now());
        },
      },
    );
    try {
      await this.awaitAck(handle, method, options?.signal, rpcId);
    } catch (error) {
      if (responsePromise) void responsePromise.catch(() => undefined);
      throw error;
    }
    const response = await this.awaitAbort(responsePromise, options?.signal, async () => {
      const pending = this.pending.get(correlationId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(correlationId);
        pending.reject(new Error("MCP request cancelled"));
      }
      void this.sendNotification("notifications/cancelled", { requestId: rpcId }).catch(() => undefined);
    });
    return response;
  }

  async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const payload: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params: params as JsonRpcNotification["params"] }),
    };
    const handle = sendCommandHandle(this.peer.deviceId, Topics.MCP_NOTIFICATION, payload, undefined, undefined, {
      rejectOnNack: true,
    });
    await this.awaitAck(handle, method);
  }

  receiveResponse(envelope: Envelope<string, unknown>): boolean {
    if (envelope.kind !== Kind.EVT || envelope.topic !== Topics.MCP_RESPONSE) return false;
    if (!validateMCPResponse(envelope.payload)) return false;
    const pending = this.pending.get(envelope.corr_id);
    if (!pending || pending.rpcId !== String(envelope.payload.id)) return false;
    this.pending.delete(envelope.corr_id);
    clearTimeout(pending.timer);
    pending.resolve(envelope.payload);
    return true;
  }

  receiveNotification(envelope: Envelope<string, unknown>): boolean {
    if (envelope.kind !== Kind.EVT || envelope.topic !== Topics.MCP_NOTIFICATION) return false;
    if (!validateMCPNotification(envelope.payload)) return false;
    this.options.onNotification?.(envelope.payload as MCPNotification);
    return true;
  }

  close(reason = "MCP connection closed"): void {
    for (const [correlationId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(correlationId);
    }
  }

  private async awaitAck(handle: CommandHandle, method: string, signal?: AbortSignal, rpcId?: string): Promise<void> {
    if (!handle.correlationId) await handle.ack;
    const ack = handle.ack.catch((error: unknown) => {
      const pending = this.pending.get(handle.correlationId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(handle.correlationId);
        pending.reject(error instanceof Error ? error : new Error("MCP protocol ACK rejected"));
      }
      throw new Error(`MCP protocol ACK failed for ${method}: ${error instanceof Error ? error.message : "rejected"}`);
    });
    if (!signal) {
      await ack;
      return;
    }
    if (signal.aborted) {
      handle.cancel("MCP request cancelled before protocol ACK");
      if (rpcId) void this.sendNotification("notifications/cancelled", { requestId: rpcId }).catch(() => undefined);
      throw new Error("MCP request cancelled");
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        handle.cancel("MCP request cancelled before protocol ACK");
        if (rpcId) void this.sendNotification("notifications/cancelled", { requestId: rpcId }).catch(() => undefined);
        reject(new Error("MCP request cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      ack.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }

  private async awaitAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, cancel: () => Promise<void>): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
      await cancel();
      throw new Error("MCP request cancelled");
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        void cancel().finally(() => reject(new Error("MCP request cancelled")));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then((value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      }, (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }
}

export class MCPSessionImpl implements MCPSession {
  private readonly listeners = new Set<(notification: MCPNotification) => void>();
  private ready = false;
  private serverInfo?: MCPServerInfo;
  private toolCache?: MCPToolDefinition[];
  private resourceCache?: MCPResourceDefinition[];

  constructor(private readonly peer: MCPAuthenticatedPeer, private readonly transport: MCPTransport) {}

  async initialize(): Promise<MCPServerInfo> {
    const response = await this.transport.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    }, { timeoutMs: DEFAULT_INITIALIZE_TIMEOUT_MS });
    if (!("result" in response) || typeof response.result !== "object" || response.result === null) {
      throw new Error("Malformed MCP initialize response");
    }
    const result = response.result as Record<string, unknown>;
    if (typeof result.protocolVersion !== "string" || typeof result.serverInfo !== "object" || result.serverInfo === null) {
      throw new Error("Malformed MCP initialize response");
    }
    const serverInfo = result.serverInfo as Record<string, unknown>;
    if (typeof serverInfo.name !== "string" || serverInfo.name.length === 0 ||
      (serverInfo.version !== undefined && typeof serverInfo.version !== "string")) {
      throw new Error("Malformed MCP server information");
    }
    if (result.protocolVersion !== MCP_PROTOCOL_VERSION) throw new Error("Unsupported MCP protocol version");
    const capabilities = result.capabilities && typeof result.capabilities === "object"
      ? Object.keys(result.capabilities as Record<string, unknown>)
      : [];
    this.serverInfo = {
      id: this.peer.deviceId,
      name: serverInfo.name,
      version: serverInfo.version as string | undefined,
      protocolVersion: result.protocolVersion,
      capabilities,
    };
    await this.transport.sendNotification("notifications/initialized");
    this.ready = true;
    return this.serverInfo;
  }

  isReady(): boolean { return this.ready; }
  getInfo(): MCPServerInfo | undefined { return this.serverInfo; }
  getStatus(): MCPConnectionStatus { return this.ready ? "ready" : "connecting"; }

  async listTools(): Promise<MCPToolDefinition[]> {
    const tools: MCPToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.transport.request("tools/list", cursor ? { cursor } : undefined);
      const result = this.resultObject(response, "tools/list");
      const entries = Array.isArray(result.tools) ? result.tools : [];
      for (const entry of entries) {
        if (!this.isTool(entry)) throw new Error("Malformed MCP tool definition");
        const metadata = entry._meta as Record<string, unknown> | undefined;
const permission = metadata?.["miobots/permission"];

tools.push({
  name: entry.name,
  qualifiedName: `mcp__${this.peer.deviceId}__${entry.name.replaceAll(".", "__")}`,
  originalName: entry.name,
  serverId: this.peer.deviceId,
  description: entry.description ?? "",
  inputSchema: entry.inputSchema,
  permission:
    permission === "read" || permission === "action"
      ? permission
      : "action",
});
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    if (cursor) throw new Error("MCP tools/list pagination limit reached");
    this.toolCache = tools;
    return [...tools];
  }

  async listResources(): Promise<MCPResourceDefinition[]> {
    const resources: MCPResourceDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.transport.request("resources/list", cursor ? { cursor } : undefined);
      const result = this.resultObject(response, "resources/list");
      const entries = Array.isArray(result.resources) ? result.resources : [];
      for (const entry of entries) {
        if (!this.isResource(entry)) throw new Error("Malformed MCP resource definition");
        resources.push({ uri: entry.uri, name: entry.name, description: entry.description, mediaType: entry.mimeType, serverId: this.peer.deviceId });
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    if (cursor) throw new Error("MCP resources/list pagination limit reached");
    this.resourceCache = resources;
    return [...resources];
  }

  async callTool(call: MCPToolCall, options?: MCPCallOptions): Promise<MCPToolExecutionResult> {
    if (call.serverId !== this.peer.deviceId) return { ok: false, output: [], isError: true, error: { code: "server_mismatch", message: "Tool belongs to another MCP server" } };
    const knownTool = this.toolCache?.find((tool) => tool.qualifiedName === call.toolName || tool.name === call.toolName);
    const toolName = knownTool?.originalName ?? call.toolName;
    if (!toolName || toolName.includes("__")) return { ok: false, output: [], isError: true, error: { code: "invalid_tool_name", message: "Tool name is not valid for this MCP server" } };
    const response = await this.transport.request("tools/call", { name: toolName, arguments: call.arguments }, options);
    if (!("result" in response)) return { ok: false, output: [], isError: true, error: { code: "mcp_error", message: response.error.message } };
    const result = response.result;
    if (typeof result !== "object" || result === null) return { ok: false, output: [], isError: true, error: { code: "malformed_result", message: "MCP tool result was not an object" } };
    const content = (result as Record<string, unknown>).content;
    if (!Array.isArray(content)) return { ok: true, output: [] };
    const output: import("./types.ts").OutputBlock[] = [];
    for (const item of content) {
      const mapped = this.mapContent(item);
      if (mapped) {
        output.push(mapped);
        continue;
      }
      return {
        ok: false,
        output: [],
        isError: true,
        error: {
          code: "unsupported_content",
          message: "MCP content requires artifact or binary transfer, which is not available",
        },
      };
    }
    return { ok: (result as Record<string, unknown>).isError !== true, output, isError: (result as Record<string, unknown>).isError === true };
  }

  addNotificationListener(listener: (notification: MCPNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  handleNotification(notification: MCPNotification): void {
    if (notification.method === "notifications/tools/list_changed") this.toolCache = undefined;
    if (notification.method === "notifications/resources/list_changed") this.resourceCache = undefined;
    for (const listener of this.listeners) listener(notification);
  }

  close(reason?: string): void { this.ready = false; this.transport.close(reason); }

  private resultObject(response: JsonRpcResponse, method: string): Record<string, unknown> {
    if (!("result" in response) || typeof response.result !== "object" || response.result === null) {
      throw new Error(`MCP ${method} failed`);
    }
    return response.result as Record<string, unknown>;
  }

 private isTool(value: unknown): value is {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const item = value as Record<string, unknown>;

  return typeof item.name === "string" &&
    item.name.length > 0 &&
    item.name.length <= 256 &&
    (item.description === undefined || typeof item.description === "string") &&
    typeof item.inputSchema === "object" &&
    item.inputSchema !== null &&
    !Array.isArray(item.inputSchema) &&
    (item._meta === undefined ||
      (typeof item._meta === "object" &&
        item._meta !== null &&
        !Array.isArray(item._meta)));
}

  private isResource(value: unknown): value is { uri: string; name?: string; description?: string; mimeType?: string } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return typeof item.uri === "string" && item.uri.length > 0 && item.uri.length <= 2048;
  }

  private mapContent(value: unknown): import("./types.ts").OutputBlock | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text };
    if (item.type === "json" && "json" in item) return { type: "json", value: item.json };
    if (item.type === "resource" && typeof item.uri === "string") return { type: "resource", resource: { artifactId: item.uri, uri: item.uri, mediaType: typeof item.mimeType === "string" ? item.mimeType : undefined } };
    return undefined;
  }
}

export type MCPTransportPeer = MCPAuthenticatedPeer;