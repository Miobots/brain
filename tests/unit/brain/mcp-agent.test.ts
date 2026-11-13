import { describe, expect, it } from "vitest";
import type {
    MCPAgent,
    MCPModelGateway,
    MCPToolDefinition,
    OutputBlock,
    TaskBudget,
} from "../../../src/agents/mcp-agent/index.ts";

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
});