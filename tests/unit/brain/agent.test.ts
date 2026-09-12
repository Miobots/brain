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
        expect(res.toolCalls[0].name).toBe("test_calculator");
        expect(res.toolCalls[0].result).toEqual({ sum: 42 });
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

        expect(res.ok).toBe(true);
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
});
