import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const port = 45874;
const token = "test-dev-token";
process.env.PORT = String(port);
process.env.DEV_TOKEN = token;
process.env.ACK_TIMEOUT = "200";

let serverModule: typeof import("../../../src/brain/server.ts");

function getPort(): number {
    const addr = serverModule?.wss?.address();
    if (addr && typeof addr !== "string") {
        return addr.port;
    }
    return port;
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
                    token,
                    protocol_version: 1,
                    role: DeviceRole.HEART,
                },
            });
            client.send(encode(helloEnv));
        });

        client.on("message", (raw) => {
            const env = decode(raw instanceof ArrayBuffer ? Buffer.from(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw);
            if (env.topic === Topics.SYS_WELCOME && (env.payload as any)?.accepted) {
                resolve(client);
            }
        });

        client.once("error", reject);
    });
}

describe("Brain HTTP Dev Speak Endpoint (POST /dev/speak)", () => {
    beforeAll(async () => {
        serverModule = await import("../../../src/brain/server.ts");
        await new Promise<void>((resolve) => {
            if (serverModule.wss.address()) {
                resolve();
            } else {
                serverModule.wss.once("listening", resolve);
            }
        });
    });

    it("rejects POST /dev/speak with 400 when text is missing or empty", async () => {
        const res = await fetch(`http://127.0.0.1:${getPort()}/dev/speak`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lang: "en" }),
        });

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data).toMatchObject({ status: "error", error: expect.stringContaining("Missing or invalid 'text'") });
    });

    it("returns 503 when no heart device is connected", async () => {
        const res = await fetch(`http://127.0.0.1:${getPort()}/dev/speak`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "Hello", lang: "en" }),
        });

        expect(res.status).toBe(503);
        const data = await res.json();
        expect(data).toMatchObject({ status: "error", error: expect.stringContaining("not connected") });
    });

    it("successfully dispatches speak command, awaits ACK from Fake Heart, and returns 200", async () => {
        const heart = await connectHeart("heart-sim-01");

        // Listen for voice.speak command on fake heart and immediately send ACK
        heart.on("message", (raw) => {
            const env = decode(raw instanceof ArrayBuffer ? Buffer.from(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw);
            if (env.topic === Topics.VOICE_SPEAK && env.kind === Kind.CMD) {
                const ack = createAck(env, { accepted: true });
                heart.send(encode(ack));
            }
        });

        const res = await fetch(`http://127.0.0.1:${getPort()}/dev/speak`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "Assalam-o-alaikum", lang: "ur" }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe("acknowledged");
        expect(data.ack.topic).toBe("voice.speak");
        expect(data.ack.kind).toBe("ACK");
        expect(data.ack.payload.accepted).toBe(true);

        heart.close();
    });

    it("returns 504 timeout when connected device does not respond with ACK", async () => {
        const heart = await connectHeart("heart-sim-01");
        // Do NOT reply with ACK

        const res = await fetch(`http://127.0.0.1:${getPort()}/dev/speak`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "Will timeout", lang: "en" }),
        });

        expect(res.status).toBe(504);
        const data = await res.json();
        expect(data.status).toBe("error");
        expect(data.error).toContain("timed out");

        heart.close();
    });
});
