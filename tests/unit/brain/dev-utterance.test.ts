import { beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
    DeviceRole,
    Kind,
    Topics,
    createAck,
    decode,
    encode,
    newEnvelope,
    type Envelope,
} from "@miobots/protocol";
import * as aiClient from "../../../src/ai/client.ts";
import { config } from "../../../src/brain/config.ts";

let serverModule: typeof import("../../../src/brain/server.ts");

function getPort(): number {
    const addr = serverModule?.wss?.address();
    if (addr && typeof addr !== "string") {
        return addr.port;
    }
    return config.port;
}

function connectHeart(deviceId = "heart-sim-01") {
    return new Promise<WebSocket>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${getPort()}/ws`);
        client.once("open", () => {
            const helloEnv = newEnvelope({
                kind: Kind.CMD,
                topic: Topics.SYS_HELLO,
                payload: {
                    device_id: deviceId,
                    token: config.devToken,
                    protocol_version: 1,
                    role: DeviceRole.HEART,
                },
            });
            client.send(encode(helloEnv));
        });

        client.on("message", (raw) => {
            const env = decode(
                raw instanceof ArrayBuffer
                    ? Buffer.from(raw)
                    : Array.isArray(raw)
                    ? Buffer.concat(raw)
                    : raw
            );
            if (env.topic === Topics.SYS_WELCOME && (env.payload as any)?.accepted) {
                resolve(client);
            }
        });

        client.once("error", reject);
    });
}

describe("Brain HTTP Dev Utterance Endpoint (POST /dev/utterance)", () => {
    beforeAll(async () => {
        serverModule = await import("../../../src/brain/server.ts");
        await new Promise((r) => setTimeout(r, 50));
    });

    it("rejects POST /dev/utterance with 400 when text is missing or empty", async () => {
        const res = await fetch(`http://127.0.0.1:${getPort()}/dev/utterance`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });

        expect(res.status).toBe(400);
        const data = (await res.json()) as any;
        expect(data.error).toContain("Missing or invalid 'text'");
    });

    it("processes utterance, executes speak tool on Fake Heart, and returns 200 response", async () => {
        const client = await connectHeart("heart-sim-01");

        let receivedCommand: Envelope<string, any> | undefined;

        client.on("message", (raw) => {
            const env = decode(
                raw instanceof ArrayBuffer
                    ? Buffer.from(raw)
                    : Array.isArray(raw)
                    ? Buffer.concat(raw)
                    : raw
            );

            if (env.topic === Topics.VOICE_SPEAK && env.kind === Kind.CMD) {
                receivedCommand = env;
                const ack = createAck(env, {
                    accepted: true,
                    exec_status: "completed",
                });
                client.send(encode(ack));
            }
        });

        // Mock LLM turn 1: Call speak tool with Urdu greeting
        // Mock LLM turn 2: Return final confirmation text
        vi.spyOn(aiClient, "chat")
            .mockResolvedValueOnce({
                ok: true,
                correlationId: "utt-1",
                toolCalls: [
                    {
                        id: "call-speak-1",
                        name: "speak",
                        arguments: { text: "Assalam-o-alaikum", lang: "ur" },
                    },
                ],
                files: [],
                finishReason: "tool_calls",
                provider: "mock-prov",
                model: "mock-model",
                capability: "fast",
                usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
                latencyMs: 30,
            })
            .mockResolvedValueOnce({
                ok: true,
                correlationId: "utt-1",
                text: "I have spoken the greeting in Urdu.",
                files: [],
                finishReason: "stop",
                provider: "mock-prov",
                model: "mock-model",
                capability: "fast",
                usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
                latencyMs: 35,
            });

        const res = await fetch(`http://127.0.0.1:${getPort()}/dev/utterance`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: "say salam in urdu",
                device_id: "heart-sim-01",
            }),
        });

        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
        expect(data.text).toBe("I have spoken the greeting in Urdu.");
        expect(data.iterations).toBe(2);
        expect(data.toolCalls).toHaveLength(1);
        expect(data.toolCalls[0].name).toBe("speak");

        expect(receivedCommand).toBeDefined();
        expect(receivedCommand?.topic).toBe(Topics.VOICE_SPEAK);
        expect(receivedCommand?.payload.text).toBe("Assalam-o-alaikum");
        expect(receivedCommand?.payload.lang).toBe("ur");

        client.close();
    });
});
