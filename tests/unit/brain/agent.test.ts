import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAgentLoop, DEFAULT_MAX_ITERATIONS } from "../../../src/brain/agent.ts";
import * as aiClient from "../../../src/ai/client.ts";
import { registerTool, speakTool } from "../../../src/brain/tools.ts";

describe("Brain ReAct Agent Loop (src/brain/agent.ts)", () => {
    let chatSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("terminates in 1 iteration when the model returns direct text without tool calls", async () => {
        chatSpy = vi.spyOn(aiClient, "chat").mockResolvedValueOnce({
            ok: true,
            correlationId: "corr-1",
            text: "Hello! I am Mio, your robot assistant.",
            files: [],
            finishReason: "stop",
            provider: "mock-prov",
            model: "mock-model",
            capability: "fast",
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            latencyMs: 50,
        });

        const res = await runAgentLoop({
            text: "Hello",
            correlationId: "corr-1",
        });

        expect(res.ok).toBe(true);
        expect(res.text).toBe("Hello! I am Mio, your robot assistant.");
        expect(res.iterations).toBe(1);
        expect(res.toolCalls).toHaveLength(0);
        expect(chatSpy).toHaveBeenCalledTimes(1);
    });

    it("executes tool call in Turn 1 and completes with final text in Turn 2", async () => {
        const mockTool = {
            name: "test_calculator",
            description: "Add two numbers",
            parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
            execute: vi.fn().mockResolvedValue({ sum: 42 }),
        };
        registerTool(mockTool);

        // Turn 1: Model calls tool
        // Turn 2: Model returns text observation
        chatSpy = vi.spyOn(aiClient, "chat")
            .mockResolvedValueOnce({
                ok: true,
                correlationId: "corr-2",
                toolCalls: [
                    {
                        id: "call-1",
                        name: "test_calculator",
                        arguments: { a: 20, b: 22 },
                    },
                ],
                files: [],
                finishReason: "tool_calls",
                provider: "mock-prov",
                model: "mock-model",
                capability: "fast",
                usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
                latencyMs: 40,
            })
            .mockResolvedValueOnce({
                ok: true,
                correlationId: "corr-2",
                text: "The calculated sum is 42.",
                files: [],
                finishReason: "stop",
                provider: "mock-prov",
                model: "mock-model",
                capability: "fast",
                usage: { promptTokens: 25, completionTokens: 10, totalTokens: 35 },
                latencyMs: 45,
            });

        const res = await runAgentLoop({
            text: "What is 20 + 22?",
            correlationId: "corr-2",
        });

        expect(res.ok).toBe(true);
        expect(res.text).toBe("The calculated sum is 42.");
        expect(res.iterations).toBe(2);
        expect(res.toolCalls).toHaveLength(1);
        expect(res.toolCalls[0]!.name).toBe("test_calculator");
        expect(res.toolCalls[0]!.result).toEqual({ sum: 42 });
        expect(mockTool.execute).toHaveBeenCalledWith({ a: 20, b: 22 });
        expect(chatSpy).toHaveBeenCalledTimes(2);
    });

    it("enforces the hard 5-iteration cap when model loops tools continuously", async () => {
        const loopTool = {
            name: "loop_tool",
            description: "Repeats indefinitely",
            parameters: { type: "object", properties: {} },
            execute: vi.fn().mockResolvedValue({ status: "still looping" }),
        };
        registerTool(loopTool);

        chatSpy = vi.spyOn(aiClient, "chat").mockImplementation(async () => ({
            ok: true,
            correlationId: "corr-loop",
            toolCalls: [
                {
                    id: `call-loop`,
                    name: "loop_tool",
                    arguments: {},
                },
            ],
            files: [],
            finishReason: "tool_calls",
            provider: "mock-prov",
            model: "mock-model",
            capability: "fast",
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            latencyMs: 10,
        }));

        const res = await runAgentLoop({
            text: "Loop forever",
            correlationId: "corr-loop",
        });

        // Hitting the cap means no final answer was produced: that is not a success.
        expect(res.ok).toBe(false);
        expect(res.error).toContain("max iteration");
        expect(res.iterations).toBe(DEFAULT_MAX_ITERATIONS);
        expect(res.toolCalls).toHaveLength(5);
        expect(chatSpy).toHaveBeenCalledTimes(5);
    });

    it("gracefully handles LLM turn failure", async () => {
        chatSpy = vi.spyOn(aiClient, "chat").mockResolvedValueOnce({
            ok: false,
            correlationId: "corr-err",
            capability: "fast",
            error: {
                code: "rate_limited",
                message: "Provider rate limit reached",
            },
        });

        const res = await runAgentLoop({
            text: "Hello",
            correlationId: "corr-err",
        });

        expect(res.ok).toBe(false);
        expect(res.error).toBe("Provider rate limit reached");
        expect(res.iterations).toBe(1);
    });

    const toolTurn = (name: string, args: Record<string, unknown>) => ({
        ok: true as const,
        correlationId: "c",
        toolCalls: [{ id: "call-x", name, arguments: args }],
        files: [],
        finishReason: "tool_calls" as const,
        provider: "mock-prov",
        model: "mock-model",
        capability: "fast",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 1,
    });
    const textTurn = (text: string) => ({ ...toolTurn("", {}), toolCalls: undefined, text, finishReason: "stop" as const });

    it("gives the model schemas only, and executes each tool call exactly once", async () => {
        const execute = vi.fn().mockResolvedValue({ done: true });
        const tool = { name: "once_tool", description: "d", parameters: { type: "object" }, execute };
        chatSpy = vi.spyOn(aiClient, "chat")
            .mockResolvedValueOnce(toolTurn("once_tool", {}))
            .mockResolvedValueOnce(textTurn("done"));

        await runAgentLoop({ text: "go", tools: [tool] });

        for (const [req] of chatSpy.mock.calls) {
            for (const t of (req as any).tools) expect(t.execute).toBeUndefined();
        }
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it("sends the assistant tool-call turn before its tool result", async () => {
        const tool = { name: "t", description: "d", parameters: { type: "object" }, execute: vi.fn().mockResolvedValue("r") };
        chatSpy = vi.spyOn(aiClient, "chat")
            .mockResolvedValueOnce(toolTurn("t", { a: 1 }))
            .mockResolvedValueOnce(textTurn("done"));

        await runAgentLoop({ text: "go", tools: [tool] });

        const messages = (chatSpy.mock.calls[1][0] as any).messages;
        const i = messages.findIndex((m: any) => m.role === "assistant");
        expect(messages[i].toolCalls).toEqual([{ id: "call-x", name: "t", arguments: { a: 1 } }]);
        expect(messages[i + 1]).toMatchObject({ role: "tool", toolCallId: "call-x" });
    });

    it("the request's deviceId beats a device_id the model made up", async () => {
        const execute = vi.fn().mockResolvedValue({});
        const tool = { name: "t", description: "d", parameters: { type: "object" }, execute };
        chatSpy = vi.spyOn(aiClient, "chat")
            .mockResolvedValueOnce(toolTurn("t", { device_id: "someone-elses-heart" }))
            .mockResolvedValueOnce(textTurn("done"));

        await runAgentLoop({ text: "go", tools: [tool], deviceId: "heart-sim-01" });

        expect(execute).toHaveBeenCalledWith({ device_id: "heart-sim-01" });
    });

    it("only dispatches tools from this request's tool set", async () => {
        const registered = { name: "global_only", description: "d", parameters: { type: "object" }, execute: vi.fn() };
        registerTool(registered);
        const custom = { name: "custom_only", description: "d", parameters: { type: "object" }, execute: vi.fn().mockResolvedValue("ok") };
        chatSpy = vi.spyOn(aiClient, "chat")
            .mockResolvedValueOnce(toolTurn("global_only", {}))
            .mockResolvedValueOnce(toolTurn("custom_only", {}))
            .mockResolvedValueOnce(textTurn("done"));

        const res = await runAgentLoop({ text: "go", tools: [custom] });

        expect(registered.execute).not.toHaveBeenCalled();
        expect(custom.execute).toHaveBeenCalledTimes(1);
        expect(res.toolCalls[0]!.result).toEqual({ error: "Tool 'global_only' is not registered or executable" });
    });

    it("clamps maxIterations to the hard cap, and never below one turn", async () => {
        const tool = { name: "t", description: "d", parameters: { type: "object" }, execute: vi.fn().mockResolvedValue({}) };
        chatSpy = vi.spyOn(aiClient, "chat").mockImplementation(async () => toolTurn("t", {}));

        expect((await runAgentLoop({ text: "go", tools: [tool], maxIterations: 100 })).iterations).toBe(DEFAULT_MAX_ITERATIONS);
        expect((await runAgentLoop({ text: "go", tools: [tool], maxIterations: 0 })).iterations).toBe(1);
        expect((await runAgentLoop({ text: "go", tools: [tool], maxIterations: -3 })).iterations).toBe(1);
    });

    it("a Heart refusal fails the request instead of being talked over", async () => {
        const tool = {
            name: "t", description: "d", parameters: { type: "object" },
            execute: vi.fn().mockRejectedValue(new Error("Heart refused voice.speak: muted")),
        };
        chatSpy = vi.spyOn(aiClient, "chat")
            .mockResolvedValueOnce(toolTurn("t", {}))
            .mockResolvedValueOnce(textTurn("All done!"));

        const res = await runAgentLoop({ text: "go", tools: [tool] });

        expect(res.ok).toBe(false);
        expect(res.error).toContain("muted");
        expect(res.text).not.toBe("All done!");
        expect(chatSpy).toHaveBeenCalledTimes(1);
    });
});
