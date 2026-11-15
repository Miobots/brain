import { describe, expect, it, vi } from "vitest";
import { chat as sharedChat } from "../../../src/ai/client.ts";
import type { ChatResult, ToolCall } from "../../../src/ai/types.ts";
import { MCPAgentRunner, runMCPAgent } from "../../../src/agents/mcp-agent/agent.ts";
import { MCPToolExecutor } from "../../../src/agents/mcp-agent/tool-executor.ts";
import type {
    MCPAgent,
    MCPConnectionManager,
    MCPModelGateway,
    MCPToolDefinition,
    OutputBlock,
    TaskBudget,
} from "../../../src/agents/mcp-agent/index.ts";
import { MCPToolRegistry } from "../../../src/agents/mcp-agent/tool-registry.ts";
import type { MCPToolExecutionResult } from "../../../src/agents/mcp-agent/types.ts";

describe("MCP Agent contracts", () => {
    it("supports the required task statuses, budget fields, and typed outputs", () => {
        const budget = {
            maxIterations: 4,
            maxModelCalls: 4,
            maxMcpCalls: 8,
            maxExecutionTimeMs: 30_000,
            maxConcurrentCalls: 2,
            maxOutputBytes: 1_000_000,
        } satisfies TaskBudget;

        const outputs = [
            { type: "text", text: "done" },
            { type: "json", value: { ok: true } },
            { type: "resource", resource: { artifactId: "artifact-1" } },
        ] satisfies OutputBlock[];

        expect(budget.maxMcpCalls).toBe(8);
        expect(outputs.map((output) => output.type)).toEqual(["text", "json", "resource"]);
    });

    it("keeps model and agent contracts implementation-independent", () => {
        const tool: MCPToolDefinition = {
            name: "capture_screen",
            qualifiedName: "mcp__ganglion__capture_screen",
            serverId: "ganglion",
            description: "Capture the current screen",
            inputSchema: { type: "object" },
        };

        const gateway: MCPModelGateway = {
            async invoke() {
                return {
                    output: [{ type: "text", text: "ready" }],
                    toolCalls: [],
                    finishReason: "stop",
                    model: "configured-model",
                };
            },
        };

        const agent: MCPAgent = {
            async run() {
                return {
                    taskId: "task-1",
                    status: "completed",
                    output: [],
                    toolCalls: [],
                    errors: [],
                    iterations: 1,
                    modelCalls: 1,
                    mcpCalls: 0,
                    artifacts: [],
                    startedAt: Date.now(),
                };
            },
            async cancel() {},
            getTask() {
                return undefined;
            },
        };

        expect(tool.qualifiedName).toBe("mcp__ganglion__capture_screen");
        expect(gateway).toBeDefined();
        expect(agent).toBeDefined();
    });

    it("uses attach and detach for authenticated peers rather than outbound connects", () => {
        const manager: MCPConnectionManager = {
            async attach() { throw new Error("not implemented in contract fixture"); },
            async detach() {},
            getStatus() { return "disconnected"; },
            getReadyServers() { return []; },
            getSession() { return undefined; },
            async request() { throw new Error("not implemented in contract fixture"); },
            getAvailableTools() { return []; },
            getTool() { return undefined; },
            async refresh() { return []; },
            onStateChange() { return () => undefined; },
        };

        expect(manager.getStatus("ganglion")).toBe("disconnected");
        expect(manager.getSession("ganglion")).toBeUndefined();
    });
});

const mcpSchema = { type: "object", properties: { value: { type: "string" } }, additionalProperties: false };

function mcpTool(serverId: string, name: string): MCPToolDefinition {
    return {
        name,
        qualifiedName: `mcp__${serverId}__${name}`,
        serverId,
        description: `${serverId} ${name}`,
        inputSchema: mcpSchema,
        permission: "read",
    };
}

function modelSuccess(text?: string, toolCalls?: ToolCall[]): ChatResult {
    return {
        ok: true,
        correlationId: "corr-1",
        ...(text === undefined ? {} : { text }),
        ...(toolCalls === undefined ? {} : { toolCalls }),
        files: [],
        finishReason: toolCalls?.length ? "tool_calls" : "stop",
        provider: "mock-provider",
        model: "mock-model",
        capability: "orchestrator",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 1,
    };
}

function modelToolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
    return { id, name, arguments: args };
}

function mcpHarness(definitions: MCPToolDefinition[] = [], result: MCPToolExecutionResult = {
    ok: true,
    output: [{ type: "text", text: "tool output" }],
}) {
    const registry = new MCPToolRegistry();
    registry.register(definitions);
    const execute = vi.fn(async () => result);
    const executor = { execute } as unknown as MCPToolExecutor;
    const chat = vi.fn<typeof sharedChat>();
    return { registry, executor, execute, chat };
}

describe("MCP Agent execution loop", () => {
    it("returns a final model response and sends MCP schemas without executors", async () => {
        const definition = mcpTool("alpha", "lookup");
        const deps = mcpHarness([definition]);
        deps.chat.mockResolvedValueOnce(modelSuccess("Found it."));

        const result = await runMCPAgent({ instruction: "Find the record." }, deps);

        expect(result.status).toBe("completed");
        expect(result.output).toEqual([{ type: "text", text: "Found it." }]);
        expect(result.iterations).toBe(1);
        expect(deps.chat.mock.calls[0]![0]).toMatchObject({ includeBuiltinTools: false });
        expect(deps.chat.mock.calls[0]![0].tools).toEqual([{
            name: definition.qualifiedName,
            description: definition.description,
            parameters: definition.inputSchema,
        }]);
        expect(deps.chat.mock.calls[0]![0].tools?.[0]).not.toHaveProperty("execute");
    });

    it("discovers namespaced tools for multiple servers and filters when requested", async () => {
        const alpha = mcpTool("alpha", "read");
        const beta = mcpTool("beta", "read");
        const deps = mcpHarness([alpha, beta]);
        deps.chat.mockResolvedValueOnce(modelSuccess("ready"));

        await runMCPAgent({ instruction: "Use alpha", serverIds: ["alpha"] }, deps);

        expect(deps.chat.mock.calls[0]![0].tools?.map((item) => item.name)).toEqual([alpha.qualifiedName]);
    });

    it("executes a tool through MCPToolExecutor and appends the paired result", async () => {
        const definition = mcpTool("alpha", "lookup");
        const deps = mcpHarness([definition]);
        deps.chat
            .mockResolvedValueOnce(modelSuccess(undefined, [modelToolCall("call-1", definition.qualifiedName, { value: "x" })]))
            .mockResolvedValueOnce(modelSuccess("Here is the answer."));

        const result = await runMCPAgent({ instruction: "Look it up" }, deps);

        expect(result.status).toBe("completed");
        expect(deps.execute).toHaveBeenCalledWith(definition.qualifiedName, { value: "x" }, { signal: undefined });
        const history = deps.chat.mock.calls[1]![0].messages;
        expect(history.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
        expect(history[2]).toMatchObject({ role: "assistant", toolCalls: [{ id: "call-1", name: definition.qualifiedName }] });
        expect(history[3]).toMatchObject({ role: "tool", toolCallId: "call-1", name: definition.qualifiedName, content: "tool output" });
    });

    it("runs multiple tool calls over multiple model iterations", async () => {
        const first = mcpTool("alpha", "first");
        const second = mcpTool("beta", "second");
        const deps = mcpHarness([first, second]);
        deps.chat
            .mockResolvedValueOnce(modelSuccess(undefined, [modelToolCall("call-1", first.qualifiedName)]))
            .mockResolvedValueOnce(modelSuccess(undefined, [modelToolCall("call-2", second.qualifiedName)]))
            .mockResolvedValueOnce(modelSuccess("Both tools completed."));

        const result = await runMCPAgent({ instruction: "Use both servers" }, deps);

        expect(result.status).toBe("completed");
        expect(result.iterations).toBe(3);
        expect(result.mcpCalls).toBe(2);
        expect(deps.execute).toHaveBeenCalledTimes(2);
        expect(deps.chat.mock.calls[2]![0].messages.map((message) => message.role)).toEqual([
            "system", "user", "assistant", "tool", "assistant", "tool",
        ]);
    });

    it("does not execute a call that already contains a result", async () => {
        const definition = mcpTool("alpha", "lookup");
        const deps = mcpHarness([definition]);
        deps.chat
            .mockResolvedValueOnce(modelSuccess(undefined, [{ ...modelToolCall("call-1", definition.qualifiedName), result: "already ran" }]))
            .mockResolvedValueOnce(modelSuccess("Done."));

        await runMCPAgent({ instruction: "Lookup" }, deps);

        expect(deps.execute).not.toHaveBeenCalled();
        expect(deps.chat.mock.calls[1]![0].messages[3]).toMatchObject({ role: "tool", content: "already ran" });
    });

    it("handles unknown tools safely without executor calls", async () => {
        const deps = mcpHarness();
        deps.chat
            .mockResolvedValueOnce(modelSuccess(undefined, [modelToolCall("missing", "mcp__ghost__missing")]))
            .mockResolvedValueOnce(modelSuccess("That tool is unavailable."));

        const result = await runMCPAgent({ instruction: "Call the missing tool" }, deps);

        expect(result.status).toBe("failed");
        expect(result.errors[0]?.code).toBe("unknown_tool");
        expect(deps.execute).not.toHaveBeenCalled();
        expect(deps.chat.mock.calls[1]![0].messages[3]).toMatchObject({ role: "tool", content: expect.stringContaining("not registered") });
    });

    it("records MCP execution failures and does not report task success", async () => {
        const definition = mcpTool("alpha", "action");
        const deps = mcpHarness([definition], {
            ok: false,
            isError: true,
            output: [],
            error: { code: "permission_denied", message: "Approval was denied." },
        });
        deps.chat
            .mockResolvedValueOnce(modelSuccess(undefined, [modelToolCall("call-1", definition.qualifiedName)]))
            .mockResolvedValueOnce(modelSuccess("The action was not performed."));

        const result = await runMCPAgent({ instruction: "Run the action" }, deps);

        expect(result.status).toBe("failed");
        expect(result.errors[0]).toMatchObject({ code: "permission_denied", message: "Approval was denied." });
        expect(deps.chat.mock.calls[1]![0].messages[3]).toMatchObject({ role: "tool", content: expect.stringContaining("Tool execution failed") });
        expect(result.output).toEqual([{ type: "text", text: "The action was not performed." }]);
    });

    it("rejects malformed arguments before execution", async () => {
        const definition = mcpTool("alpha", "lookup");
        const deps = mcpHarness([definition]);
        const malformed = { id: "bad", name: definition.qualifiedName, arguments: [] } as unknown as ToolCall;
        deps.chat
            .mockResolvedValueOnce(modelSuccess(undefined, [malformed]))
            .mockResolvedValueOnce(modelSuccess("The arguments were invalid."));

        const result = await runMCPAgent({ instruction: "Lookup" }, deps);

        expect(result.errors[0]?.code).toBe("invalid_arguments");
        expect(deps.execute).not.toHaveBeenCalled();
    });

    it("enforces the configured iteration limit", async () => {
        const definition = mcpTool("alpha", "repeat");
        const deps = mcpHarness([definition]);
        deps.chat.mockResolvedValue(modelSuccess(undefined, [modelToolCall("call-1", definition.qualifiedName)]));

        const result = await runMCPAgent({ instruction: "Continue" }, deps, { budget: { maxIterations: 2 } });

        expect(result.status).toBe("failed");
        expect(result.iterations).toBe(2);
        expect(result.errors.at(-1)?.code).toBe("max_iterations");
        expect(deps.chat).toHaveBeenCalledTimes(2);
    });

    it("handles model failures and empty responses", async () => {
        const failed = mcpHarness();
        failed.chat.mockResolvedValueOnce({
            ok: false,
            correlationId: "corr-1",
            capability: "orchestrator",
            error: { code: "provider_unreachable", message: "Provider is down." },
        });
        expect((await runMCPAgent({ instruction: "Hi" }, failed)).errors[0]?.message).toBe("Provider is down.");

        const empty = mcpHarness();
        empty.chat.mockResolvedValueOnce(modelSuccess());
        expect((await runMCPAgent({ instruction: "Hi" }, empty)).errors[0]?.code).toBe("empty_model_response");
    });

    it("passes MCP image attachments to the next model turn", async () => {
        const definition = mcpTool("alpha", "capture");
        const bytes = new Uint8Array([1, 2, 3]);
        const deps = mcpHarness([definition], {
            ok: true,
            output: [{
                type: "image",
                source: { source: { data: bytes, filename: "screen.png" }, mediaType: "image/png" },
                mediaType: "image/png",
            }],
        });
        deps.chat
            .mockResolvedValueOnce(modelSuccess(undefined, [modelToolCall("image-call", definition.qualifiedName)]))
            .mockResolvedValueOnce(modelSuccess("I can see the screen."));

        const result = await runMCPAgent({ instruction: "Inspect the screen" }, deps);

        expect(result.status).toBe("completed");
        expect(deps.chat.mock.calls[1]![0].messages[3]).toMatchObject({
            role: "tool",
            attachments: [{ mediaType: "image/png", source: { data: bytes, filename: "screen.png" } }],
        });
    });

    it("provides a callable runner implementing the independent loop contract", async () => {
        const deps = mcpHarness();
        deps.chat.mockResolvedValueOnce(modelSuccess("Ready."));

        const result = await new MCPAgentRunner(deps).execute({ instruction: "Start" });

        expect(result.status).toBe("completed");
    });
});