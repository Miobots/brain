import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
    BrainCapabilities,
    DeviceRole,
    Kind,
    Topics,
    createAck,
    decode,
    encode,
    newEnvelope,
    SequenceCounter,
} from "@miobots/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairDevice } from "../../../src/brain/pairing.ts";
import { config } from "../../../src/brain/config.ts";
import { devices, deviceRoles } from "../../../src/brain/devices.ts";
import { mcpConnectionManager } from "../../../src/agents/mcp-agent/manager.ts";
import { brainManifest } from "../../../src/brain/capabilities.ts";
import type { MCPAuthenticatedPeer } from "../../../src/agents/mcp-agent/types.ts";

process.env.PORT = "45880";
process.env.DEV_TOKEN = "mcp-test-token";
process.env.MCP_DEV_HTTP_TOKEN = "mcp-http-test-token";
config.mcp_request_timeout_ms = 250;

let serverModule: typeof import("../../../src/brain/server.ts");
const clients: WebSocket[] = [];

function rawEnvelope(raw: WebSocket.RawData) {
    return decode(raw instanceof ArrayBuffer ? Buffer.from(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw);
}

function connectGanglion(deviceId = "ganglion-test"): Promise<{ client: WebSocket; seq: SequenceCounter }> {
    return new Promise((resolve, reject) => {
        const address = serverModule.wss.address();
        const port = address && typeof address !== "string" ? address.port : config.port;
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const seq = new SequenceCounter();
        client.once("open", () => client.send(encode(newEnvelope({
            kind: Kind.CMD,
            topic: Topics.SYS_HELLO,
            payload: { device_id: deviceId, token: config.devToken, protocol_version: 1, role: DeviceRole.GANGLION },
            seq,
        }))));
        client.on("message", (raw) => {
            const envelope = rawEnvelope(raw);
            if (envelope.topic === Topics.SYS_WELCOME && (envelope.payload as { accepted?: boolean }).accepted) {
                clients.push(client);
                resolve({ client, seq });
            }
        });
        client.once("error", reject);
    });
}

function sendMcpResponse(client: WebSocket, seq: SequenceCounter, correlationId: string, id: string, result: unknown): void {
    client.send(encode(newEnvelope({
        kind: Kind.EVT,
        topic: Topics.MCP_RESPONSE,
        corr_id: correlationId,
        payload: { jsonrpc: "2.0", id, result: result as import("@miobots/protocol").JsonValue },
        seq,
    })));
}

async function closeAll(): Promise<void> {
    for (const client of clients.splice(0)) if (client.readyState === WebSocket.OPEN) client.close();
    mcpConnectionManager.clear();
    devices.clear();
    deviceRoles.clear();
}

async function waitForSession(serverId: string): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (!mcpConnectionManager.getSession(serverId) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(mcpConnectionManager.getSession(serverId)).toBeDefined();
}

describe("Brain MCP transport and session", () => {
    beforeAll(async () => {
        serverModule = await import("../../../src/brain/server.ts");
        // The test server is shared across files, so pair with the token it is actually running with.
        process.env.PAIRED_GANGLIONS_FILE = join(mkdtempSync(join(tmpdir(), "brain-pair-")), "paired.json");
        pairDevice("ganglion-test", "test laptop", config.devToken);
        await new Promise((resolve) => setTimeout(resolve, 30));
    });

    afterEach(async () => closeAll());

    it("initializes an allowlisted Ganglion session and handles tools/list", async () => {
        const states: string[] = [];
        const unsubscribe = mcpConnectionManager.onStateChange((_serverId, status) => states.push(status));
        const { client, seq } = await connectGanglion();
        client.on("message", (raw) => {
            const envelope = rawEnvelope(raw);
            if (envelope.kind !== Kind.CMD) return;
            const payload = envelope.payload as { method?: string; id?: string };
            client.send(encode(createAck(envelope, { accepted: true }, seq)));
            if (envelope.topic === Topics.MCP_REQUEST && payload.method === "initialize") {
                sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    serverInfo: { name: "test-ganglion", version: "1.0" },
                });
            } else if (envelope.topic === Topics.MCP_REQUEST && payload.method === "tools/list") {
                sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), {
                    tools: [{ name: "capture_screen", description: "Capture", inputSchema: { type: "object" } }],
                });
            } else if (envelope.topic === Topics.MCP_NOTIFICATION) {
                expect(payload.method).toBe("notifications/initialized");
            }
        });

        await waitForSession("ganglion-test");
        const session = mcpConnectionManager.getSession("ganglion-test")!;
        const tools = await session.listTools();
        expect(tools[0]).toMatchObject({ qualifiedName: "mcp__ganglion-test__capture_screen", permission: "action" });
        expect(mcpConnectionManager.getStatus("ganglion-test")).toBe("ready");
        expect(mcpConnectionManager.getReadyServers()[0]).toMatchObject({ id: "ganglion-test", name: "test-ganglion" });
        expect(mcpConnectionManager.getAvailableTools("ganglion-test")).toEqual(tools);
        expect(mcpConnectionManager.getTool(tools[0]!.qualifiedName)).toEqual(tools[0]);
        expect(states).toEqual(expect.arrayContaining(["connecting", "initializing", "ready"]));
        unsubscribe();
    });

    it("preserves structured MCP tool errors returned by Ganglion", async () => {
        const { client, seq } = await connectGanglion();
        client.on("message", (raw) => {
            const envelope = rawEnvelope(raw);
            if (envelope.kind !== Kind.CMD) return;
            const payload = envelope.payload as { method?: string; id?: string };
            client.send(encode(createAck(envelope, { accepted: true }, seq)));
            if (envelope.topic !== Topics.MCP_REQUEST) return;
            if (payload.method === "initialize") sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), {
                protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test-ganglion" },
            });
            if (payload.method === "tools/list") sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), {
                tools: [{ name: "filesystem.write_file", inputSchema: { type: "object" }, _meta: { "miobots/permission": "action" } }],
            });
            if (payload.method === "tools/call") sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), {
                isError: true,
                content: [{ type: "text", text: JSON.stringify({ code: "approval_required", message: "Trusted approval is required" }) }],
            });
        });

        await waitForSession("ganglion-test");
        const session = mcpConnectionManager.getSession("ganglion-test")!;
        const [tool] = await session.listTools();
        const result = await session.callTool({
            id: "write-1",
            toolName: tool!.qualifiedName,
            serverId: "ganglion-test",
            arguments: { path: "/tmp/note.txt", content: "hello" },
        });
        expect(result).toMatchObject({
            ok: false,
            isError: true,
            error: { code: "approval_required", message: "Trusted approval is required" },
        });
    });

    it("fails closed for an unpaired Ganglion, even with the dev token", async () => {
        const address = serverModule.wss.address();
        const port = address && typeof address !== "string" ? address.port : config.port;
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const welcome = await new Promise<{ accepted?: boolean }>((resolve, reject) => {
            client.once("open", () => client.send(encode(newEnvelope({
                kind: Kind.CMD,
                topic: Topics.SYS_HELLO,
                payload: { device_id: "other-ganglion", token: config.devToken, protocol_version: 1, role: DeviceRole.GANGLION },
                seq: new SequenceCounter(),
            }))));
            client.once("message", (raw) => resolve(rawEnvelope(raw).payload as { accepted?: boolean }));
            client.once("error", reject);
        });
        expect(welcome.accepted).toBe(false);
        expect(mcpConnectionManager.getSession("other-ganglion")).toBeUndefined();
        expect(deviceRoles.has("other-ganglion")).toBe(false);
        expect(brainManifest(deviceRoles.values()).capabilities[BrainCapabilities.LAPTOP_DAEMON]?.state).toBe("unavailable");
        client.close();
    });

    it("requires a bearer token for the MCP Agent endpoint", async () => {
        const address = serverModule.wss.address();
        const port = address && typeof address !== "string" ? address.port : config.port;
        const url = `http://127.0.0.1:${port}/dev/mcp-agent`;
        const body = JSON.stringify({ instruction: "Check my system status" });
        const unauthorized = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
        expect(unauthorized.status).toBe(401);
        const authorized = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer mcp-http-test-token" }, body });
        expect(authorized.status).toBe(503); // Authenticated; no Ganglion is connected.
    });

    it("rejects server-initiated MCP requests", async () => {
        const { client, seq } = await connectGanglion();
        client.on("message", (raw) => {
            const envelope = rawEnvelope(raw);
            if (envelope.topic !== Topics.MCP_REQUEST) return;
            const payload = envelope.payload as { method?: string; id?: string };
            client.send(encode(createAck(envelope, { accepted: true }, seq)));
            if (payload.method === "initialize") {
                sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), {
                    protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test" },
                });
            }
            if (payload.method === "tools/list") {
                sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), { tools: [] });
            }
        });
        client.on("message", (raw) => {
            const envelope = rawEnvelope(raw);
            if (envelope.topic === Topics.MCP_NOTIFICATION && envelope.kind === Kind.CMD) {
                client.send(encode(createAck(envelope, { accepted: true }, seq)));
            }
        });
        await waitForSession("ganglion-test");
        const response = await new Promise<Record<string, unknown>>((resolve) => {
            client.once("message", (raw) => {
                const envelope = rawEnvelope(raw);
                resolve(envelope.payload as Record<string, unknown>);
            });
            client.send(encode(newEnvelope({
                kind: Kind.CMD,
                topic: Topics.MCP_REQUEST,
                payload: { jsonrpc: "2.0", id: "server-1", method: "unsupported/request" },
                seq,
            })));
        });
        expect(response.accepted).toBe(false);
        expect(response.reason).toContain("unsupported");
    });

    it("supports paginated resources and rejects mismatched responses", async () => {
        const { client, seq } = await connectGanglion();
        client.on("message", (raw) => {
            const envelope = rawEnvelope(raw);
            if (envelope.kind !== Kind.CMD) return;
            const payload = envelope.payload as { method?: string; id?: string; params?: { cursor?: string } };
            client.send(encode(createAck(envelope, { accepted: true }, seq)));
            if (payload.method === "initialize") sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), {
                protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test" },
            });
            if (payload.method === "tools/list") sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), { tools: [] });
            if (payload.method === "tools/list") sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), { tools: [] });
            if (payload.method === "notifications/initialized") return;
            if (payload.method === "resources/list") sendMcpResponse(client, seq, envelope.corr_id, "wrong-id", {
                resources: [],
            });
        });
        await waitForSession("ganglion-test");
        const session = mcpConnectionManager.getSession("ganglion-test")!;
        await expect(session.listResources()).rejects.toThrow(/timed out/);
    });

    it("supports cancellation and ignores a late response", async () => {
        const { client, seq } = await connectGanglion();
        const cancellation = new AbortController();
        client.on("message", (raw) => {
            const envelope = rawEnvelope(raw);
            if (envelope.kind !== Kind.CMD) return;
            const payload = envelope.payload as { method?: string; id?: string };
            client.send(encode(createAck(envelope, { accepted: true }, seq)));
            if (payload.method === "initialize") sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), {
                protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test" },
            });
            if (payload.method === "tools/list") sendMcpResponse(client, seq, envelope.corr_id, String(payload.id), { tools: [] });
        });
        await waitForSession("ganglion-test");
        const session = mcpConnectionManager.getSession("ganglion-test")!;
        const promise = session.callTool({ id: "call-1", toolName: "capture_screen", serverId: "ganglion-test", arguments: {} }, { signal: cancellation.signal });
        cancellation.abort();
        await expect(promise).rejects.toThrow(/cancelled/);
    });
});
