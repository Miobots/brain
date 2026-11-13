import { describe, expect, it, vi } from "vitest";
import type { MCPConnectionManager, MCPSession } from "../../../src/agents/mcp-agent/interfaces.ts";
import type { MCPConnectionStatus, MCPServerInfo, MCPToolCall, MCPToolDefinition, MCPToolExecutionResult } from "../../../src/agents/mcp-agent/types.ts";
import { MCPToolRegistry } from "../../../src/agents/mcp-agent/tool-registry.ts";
import { MCPToolExecutor, type MCPToolPermissionProvider } from "../../../src/agents/mcp-agent/tool-executor.ts";

function tool(serverId: string, name: string, permission: "read" | "action" = "read"): MCPToolDefinition {
    return {
        name,
        originalName: name,
        qualifiedName: `mcp__${serverId}__${name}`,
        serverId,
        description: `${serverId} ${name}`,
        inputSchema: {
            type: "object",
            properties: { value: { type: "string", enum: ["a", "b"] } },
            required: ["value"],
            additionalProperties: false,
        },
        permission,
    };
}

function fakeManager(session: MCPSession, statuses: Record<string, MCPConnectionStatus> = { alpha: "ready", beta: "ready" }): MCPConnectionManager {
    return {
        async attach() { return session; },
        async detach() {},
        getStatus(serverId) { return statuses[serverId] ?? "disconnected"; },
        getReadyServers(): MCPServerInfo[] { return Object.keys(statuses).map((id) => ({ id, name: id })); },
        getSession(serverId) { return statuses[serverId] === "ready" ? session : undefined; },
        async request() { throw new Error("not used"); },
        getAvailableTools() { return []; },
        getTool() { return undefined; },
        async refresh() { return []; },
        onStateChange() { return () => undefined; },
    };
}

function permission(allowed: boolean): MCPToolPermissionProvider {
    return { authorize: vi.fn().mockResolvedValue(allowed ? { allowed: true } : { allowed: false, code: "permission_denied", message: "denied" }) };
}

describe("MCP Phase 5 tool registry and executor", () => {
    it("registers, updates, refreshes, removes, and isolates namespaced tools", () => {
        const registry = new MCPToolRegistry();
        const alpha = tool("alpha", "shared");
        const beta = tool("beta", "shared");
        registry.register([alpha, beta]);
        expect(registry.listAll()).toHaveLength(2);
        registry.update({ ...alpha, description: "updated" });
        expect(registry.get(alpha.qualifiedName)?.description).toBe("updated");
        registry.refresh([alpha], "alpha");
        expect(registry.get(beta.qualifiedName)).toBeDefined();
        expect(registry.remove(beta.qualifiedName)).toBe(true);
        expect(registry.get(beta.qualifiedName)).toBeUndefined();
    });

    it("tracks disconnected servers as unavailable", () => {
        const registry = new MCPToolRegistry();
        const definition = tool("alpha", "read");
        registry.register(definition);
        registry.updateServerStatus("alpha", "disconnected");
        expect(registry.listAvailable()).toHaveLength(0);
        expect(registry.get(definition.qualifiedName)?.connectionStatus).toBe("disconnected");
    });

    it("rejects malformed schemas and invalid arguments before manager execution", async () => {
        const calls: MCPToolCall[] = [];
        const session: MCPSession = {
            async listTools() { return []; },
            async listResources() { return []; },
            async callTool(call) { calls.push(call); return { ok: true, output: [] }; },
            addNotificationListener() { return () => undefined; },
        };
        const registry = new MCPToolRegistry();
        const definition = tool("alpha", "read");
        registry.register(definition);
        const executor = new MCPToolExecutor(registry, fakeManager(session), { permissionProvider: permission(true) });
        const invalid = await executor.execute(definition.qualifiedName, { value: "invalid" });
        expect(invalid.error?.code).toBe("invalid_arguments");
        expect(calls).toHaveLength(0);
        registry.update({ ...definition, inputSchema: undefined as never });
        const malformed = await executor.execute(definition.qualifiedName, { value: "a" });
        expect(malformed.error?.code).toBe("missing_schema");
    });

    it("checks permissions before execution and fails closed without a provider", async () => {
        const execute = vi.fn().mockResolvedValue({ ok: true, output: [] } satisfies MCPToolExecutionResult);
        const session = { listTools: async () => [], listResources: async () => [], callTool: execute, addNotificationListener: () => () => undefined } as unknown as MCPSession;
        const registry = new MCPToolRegistry();
        const definition = tool("alpha", "read");
        registry.register(definition);
        const denied = new MCPToolExecutor(registry, fakeManager(session));
        const result = await denied.execute(definition.qualifiedName, { value: "a" });
        expect(result.error?.code).toBe("approval_required");
        expect(execute).not.toHaveBeenCalled();
        const allowed = new MCPToolExecutor(registry, fakeManager(session), { permissionProvider: permission(true) });
        await allowed.execute(definition.qualifiedName, { value: "a" });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it("fails closed for an unknown permission classification", async () => {
        const session = { listTools: async () => [], listResources: async () => [], callTool: vi.fn(), addNotificationListener: () => () => undefined } as unknown as MCPSession;
        const registry = new MCPToolRegistry();
        const definition = { ...tool("alpha", "unknown"), permission: undefined };
        registry.register(definition);
        const executor = new MCPToolExecutor(registry, fakeManager(session), { permissionProvider: permission(true) });
        expect((await executor.execute(definition.qualifiedName, { value: "a" })).error?.code).toBe("permission_unknown");
        expect(session.callTool).not.toHaveBeenCalled();
    });

    it("preserves remote typed output and maps unavailable, timeout, cancellation, and remote errors", async () => {
        const session: MCPSession = {
            async listTools() { return []; },
            async listResources() { return []; },
            async callTool() { return { ok: true, output: [{ type: "image", source: { artifactId: "image-1" } }] }; },
            addNotificationListener() { return () => undefined; },
        };
        const registry = new MCPToolRegistry();
        const definition = tool("alpha", "capture");
        registry.register(definition);
        const executor = new MCPToolExecutor(registry, fakeManager(session), { permissionProvider: permission(true) });
        const result = await executor.execute(definition.qualifiedName, { value: "a" });
        expect(result.output[0]?.type).toBe("image");
        registry.updateServerStatus("alpha", "disconnected");
        expect((await executor.execute(definition.qualifiedName, { value: "a" })).error?.code).toBe("server_unavailable");
    });

    it("serializes concurrent action calls per server while allowing independent servers", async () => {
        const order: string[] = [];
        const session: MCPSession = {
            async listTools() { return []; },
            async listResources() { return []; },
            async callTool(call) {
                order.push(`start-${call.serverId}`);
                await new Promise((resolve) => setTimeout(resolve, 5));
                order.push(`end-${call.serverId}`);
                return { ok: true, output: [] };
            },
            addNotificationListener() { return () => undefined; },
        };
        const registry = new MCPToolRegistry();
        const alpha = tool("alpha", "write", "action");
        const beta = tool("beta", "write", "action");
        registry.register([alpha, beta]);
        const executor = new MCPToolExecutor(registry, fakeManager(session), { permissionProvider: permission(true) });
        await Promise.all([
            executor.execute(alpha.qualifiedName, { value: "a" }),
            executor.execute(alpha.qualifiedName, { value: "b" }),
            executor.execute(beta.qualifiedName, { value: "a" }),
        ]);
        expect(order.indexOf("end-alpha")).toBeLessThan(order.lastIndexOf("start-alpha"));
        expect(order).toContain("start-beta");
    });
});
