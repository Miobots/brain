import { beforeAll, describe, expect, it } from "vitest";
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
import {
    speakTool,
    toolRegistry,
    getTools,
    getTool,
    registerTool,
} from "../../../src/brain/tools.ts";
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

describe("Brain Tool Registry & Speak Tool (src/brain/tools.ts)", () => {
    beforeAll(async () => {
        serverModule = await import("../../../src/brain/server.ts");
        await new Promise((r) => setTimeout(r, 50));
    });

    describe("Registry Functions & Definitions", () => {
        it("registers speakTool in toolRegistry", () => {
            expect(toolRegistry.speak).toBeDefined();
            expect(toolRegistry.speak.name).toBe("speak");
            expect(toolRegistry.speak.description).toContain("robot");
        });

        it("returns all tools via getTools()", () => {
            const tools = getTools();
            expect(Array.isArray(tools)).toBe(true);
            expect(tools.some((t) => t.name === "speak")).toBe(true);
        });

        it("retrieves a specific tool via getTool()", () => {
            const tool = getTool("speak");
            expect(tool).toBeDefined();
            expect(tool?.name).toBe("speak");
            expect(getTool("non_existent")).toBeUndefined();
        });

        it("allows registering custom tools via registerTool()", () => {
            const customTool = {
                name: "custom_ping",
                description: "Ping the system",
                parameters: { type: "object", properties: {} },
                execute: () => ({ pong: true }),
            };
            registerTool(customTool);
            expect(getTool("custom_ping")).toBe(customTool);
            expect(getTools().some((t) => t.name === "custom_ping")).toBe(true);
        });
    });

    describe("speakTool Parameter & Execution Validation", () => {
        it("has valid JSON schema parameters for LLM tool calling", () => {
            expect(speakTool.parameters).toBeDefined();
            expect(speakTool.parameters.type).toBe("object");
            expect(speakTool.parameters.required).toContain("text");
            const props = speakTool.parameters.properties as Record<string, any>;
            expect(props.text.type).toBe("string");
            expect(props.lang.enum).toEqual(["en", "ur"]);
            expect(props.priority.enum).toEqual(["normal", "urgent"]);
        });

        it("rejects execute() when text argument is missing or empty", async () => {
            await expect(speakTool.execute!({})).rejects.toThrow(/Missing or empty 'text'/);
            await expect(speakTool.execute!({ text: "   " })).rejects.toThrow(/Missing or empty 'text'/);
        });

        it("rejects execute() when no device is connected", async () => {
            await expect(
                speakTool.execute!({ text: "Hello robot", device_id: "disconnected-device" })
            ).rejects.toThrow(/is not connected/);
        });

        it("successfully dispatches voice.speak to connected Heart device and receives ACK", async () => {
            const client = await connectHeart("heart-sim-01");

            let receivedSpeakCommand: Envelope<string, any> | undefined;

            client.on("message", (raw) => {
                const env = decode(
                    raw instanceof ArrayBuffer
                        ? Buffer.from(raw)
                        : Array.isArray(raw)
                        ? Buffer.concat(raw)
                        : raw
                );

                if (env.topic === Topics.VOICE_SPEAK && env.kind === Kind.CMD) {
                    receivedSpeakCommand = env;
                    const ack = createAck(env, {
                        accepted: true,
                        exec_status: "completed",
                    });
                    client.send(encode(ack));
                }
            });

            const result = (await speakTool.execute!({
                text: "Assalam-o-Alaikum",
                lang: "ur",
                priority: "urgent",
                device_id: "heart-sim-01",
            })) as Record<string, any>;

            expect(result.status).toBe("spoken");
            expect(result.text).toBe("Assalam-o-Alaikum");
            expect(result.lang).toBe("ur");
            expect(result.priority).toBe("urgent");
            expect(result.ack).toEqual({
                accepted: true,
                exec_status: "completed",
            });

            expect(receivedSpeakCommand).toBeDefined();
            expect(receivedSpeakCommand?.topic).toBe(Topics.VOICE_SPEAK);
            expect(receivedSpeakCommand?.payload).toEqual({
                text: "Assalam-o-Alaikum",
                lang: "ur",
                priority: "urgent",
            });

            client.close();
        });
    });
});
