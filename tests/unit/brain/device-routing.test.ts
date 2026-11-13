import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
    DeviceRole,
    Kind,
    Topics,
    createAck,
    decode,
    encode,
    newEnvelope,
    SequenceCounter,
} from "@miobots/protocol";
import { config } from "../../../src/brain/config.ts";
import { devices, deviceRoles } from "../../../src/brain/devices.ts";
import { speakTool } from "../../../src/brain/tools.ts";

process.env.PORT = "45879";
process.env.DEV_TOKEN = "routing-test-token";

let serverModule: typeof import("../../../src/brain/server.ts");
const clients: WebSocket[] = [];

function port(): number {
    const address = serverModule.wss.address();
    return address && typeof address !== "string" ? address.port : config.port;
}

function decodeRaw(raw: WebSocket.RawData) {
    return decode(
        raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : Array.isArray(raw)
            ? Buffer.concat(raw)
            : raw,
    );
}

function connect(deviceId: string, role: DeviceRole): Promise<{ client: WebSocket; seq: SequenceCounter }> {
    return new Promise((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${port()}/ws`);
        const seq = new SequenceCounter();
        client.once("open", () => {
            client.send(encode(newEnvelope({
                kind: Kind.CMD,
                topic: Topics.SYS_HELLO,
                payload: {
                    device_id: deviceId,
                    token: config.devToken,
                    protocol_version: 1,
                    role,
                },
                seq,
            })));
        });
        client.on("message", (raw) => {
            const message = decodeRaw(raw);
            if (message.topic === Topics.SYS_WELCOME && (message.payload as { accepted?: boolean }).accepted) {
                clients.push(client);
                resolve({ client, seq });
            }
        });
        client.once("error", reject);
    });
}

async function closeClients(): Promise<void> {
    for (const client of clients.splice(0)) {
        if (client.readyState === WebSocket.OPEN) client.close();
    }
    devices.clear();
    deviceRoles.clear();
}

async function speakAndAck(client: WebSocket, seq: SequenceCounter): Promise<void> {
    await new Promise<void>((resolve) => {
        const onMessage = (raw: WebSocket.RawData) => {
            const message = decodeRaw(raw);
            if (message.topic !== Topics.VOICE_SPEAK || message.kind !== Kind.CMD) return;
            client.off("message", onMessage);
            client.send(encode(createAck(message, { accepted: true }, seq)));
            resolve();
        };
        client.on("message", onMessage);
    });
}

describe("authenticated Heart device routing", () => {
    beforeAll(async () => {
        serverModule = await import("../../../src/brain/server.ts");
        await new Promise((resolve) => setTimeout(resolve, 30));
    });

    afterEach(async () => {
        await closeClients();
    });

    it("selects Heart when Heart connects before Ganglion", async () => {
        const heart = await connect("heart-first", DeviceRole.HEART);
        await connect("ganglion-second", DeviceRole.GANGLION);
        const ack = speakAndAck(heart.client, heart.seq);
        const result = await Promise.all([
            speakTool.execute!({ text: "hello" }),
            ack,
        ]);
        expect((result[0] as Record<string, unknown>).target_device).toBe("heart-first");
    });

    it("selects Heart when Ganglion connects before Heart", async () => {
        await connect("ganglion-first", DeviceRole.GANGLION);
        const heart = await connect("heart-second", DeviceRole.HEART);
        const ack = speakAndAck(heart.client, heart.seq);
        const result = await Promise.all([
            speakTool.execute!({ text: "hello" }),
            ack,
        ]);
        expect((result[0] as Record<string, unknown>).target_device).toBe("heart-second");
    });

    it("fails with only Ganglion and sends no command to it", async () => {
        const ganglion = await connect("only-ganglion", DeviceRole.GANGLION);
        let received = false;
        ganglion.client.on("message", () => { received = true; });
        await expect(speakTool.execute!({ text: "hello" })).rejects.toThrow(/Heart device/);
        expect(received).toBe(false);
    });

    it("uses the first authenticated Heart deterministically among multiple Hearts", async () => {
        const first = await connect("heart-a", DeviceRole.HEART);
        const second = await connect("heart-b", DeviceRole.HEART);
        const ack = speakAndAck(first.client, first.seq);
        const result = await Promise.all([
            speakTool.execute!({ text: "hello" }),
            ack,
        ]);
        expect((result[0] as Record<string, unknown>).target_device).toBe("heart-a");
        expect(second.client.readyState).toBe(WebSocket.OPEN);
    });

    it("allows an explicit Heart and rejects explicit Ganglion or disconnected IDs", async () => {
        const heart = await connect("explicit-heart", DeviceRole.HEART);
        await connect("explicit-ganglion", DeviceRole.GANGLION);
        const ack = speakAndAck(heart.client, heart.seq);
        const result = await Promise.all([
            speakTool.execute!({ text: "hello", device_id: "explicit-heart" }),
            ack,
        ]);
        expect((result[0] as Record<string, unknown>).target_device).toBe("explicit-heart");
        await expect(speakTool.execute!({ text: "hello", device_id: "explicit-ganglion" })).rejects.toThrow(/Heart device/);
        await expect(speakTool.execute!({ text: "hello", device_id: "missing" })).rejects.toThrow(/Heart device/);
    });

    it("ignores a role spoof in the requested device ID and returns 503 without a Heart", async () => {
        await connect("spoofed-ganglion", DeviceRole.GANGLION);
        const response = await fetch(`http://127.0.0.1:${port()}/dev/utterance`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "hello", device_id: "spoofed-ganglion", role: DeviceRole.HEART }),
        });
        expect(response.status).toBe(503);
        const body = await response.json() as { error?: string };
        expect(body.error).toContain("Heart device");
    });

    it("returns 503 when /dev/utterance has no authenticated Heart target", async () => {
        await connect("route-ganglion", DeviceRole.GANGLION);
        const response = await fetch(`http://127.0.0.1:${port()}/dev/utterance`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "hello" }),
        });
        expect(response.status).toBe(503);
    });
});