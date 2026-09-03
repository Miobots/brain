import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
    createWelcomeAck,
    encode,
    Kind,
    parse,
    Topics,
    validateHello,
    type HelloPayload,
} from "@miobots/protocol";
import { config } from "./config.ts";
import { handleAck } from "./hub.ts";
import { deviceCommands } from "./command-store.ts";
import { resetSequencebrain,checksequence } from "./sequence-tracker.ts";

export const wss = new WebSocketServer({
    port: config.port,
    path: "/ws",
});

export const devices = new Map<string, WebSocket>();

export function startServer(port: number, devToken: string) {
    wss.on("connection", (ws) => {
        let deviceId: string | undefined;

        ws.on("message", (rawdata: RawData) => {
            const byteLength = Buffer.isBuffer(rawdata)
                ? rawdata.byteLength
                : typeof rawdata === "string"
                ? Buffer.byteLength(rawdata)
                : Array.isArray(rawdata)
                ? rawdata.reduce((acc, chunk) => acc + chunk.byteLength, 0)
                : rawdata.byteLength;

            if (byteLength > config.max_message_size) {
                console.log(`[SERVER] Message exceeds maximum size 5MB`);
                return;
            }

            const parseData = typeof rawdata === "string"
                ? rawdata
                : Buffer.isBuffer(rawdata)
                ? rawdata
                : Array.isArray(rawdata)
                ? Buffer.concat(rawdata)
                : Buffer.from(rawdata);
            const brainData = parse(parseData);
            if (!brainData.success) {
                console.log(`[SERVER] Error: ${brainData.error}`);
                return;
            }

            const envelope = brainData.data;

            if (envelope.topic === Topics.SYS_HELLO) {
                const validation = validateHello(envelope.payload);
                if (!validation.valid) {
                    const badWelcome = createWelcomeAck(envelope, {
                        accepted: false,
                        reason: "invalid payload",
                    });
                    ws.send(encode(badWelcome));
                    console.log(`[SERVER] Invalid hello: ${validation.error} closing server`);
                    ws.close();
                    return;
                }

                const hello = envelope.payload as HelloPayload;
                if (hello.token !== devToken) {
                    const badWelcome = createWelcomeAck(envelope, {
                        accepted: false,
                        reason: "Unauthenticated token",
                    });
                    ws.send(encode(badWelcome));
                    console.log(`[SERVER] BAD DEV_TOKEN closing server`);
                    ws.close();
                    return;
                }

                deviceId = hello.device_id;
                devices.set(deviceId, ws);
                if (!deviceCommands.has(deviceId)) {
                    deviceCommands.set(deviceId, new Map());
                }

                console.log(`[SERVER] Device authenticated: ${deviceId}`);
                const welcome = createWelcomeAck(envelope, { accepted: true });
                ws.send(encode(welcome));
                console.log(`[SERVER] welcome Ack Sent`);
            }

            if (!deviceId) {
                console.log(`[SERVER] Message received before authentication`);
                return;
            }

            if (!checksequence(deviceId, envelope.seq)) {
                return;
            }

            if (envelope.kind === Kind.ACK) {
                handleAck(envelope);
            }
        });

        ws.on("close", () => {
            if (deviceId) {
                resetSequencebrain(deviceId);
                devices.delete(deviceId);
                console.log(`[Server] Device disconnected ${deviceId}`);
            }
        });

        ws.on("error", (error) => {
            console.log(`[SERVER] WebSocket error: ${error}`);
        });
    });
}

startServer(config.port, config.devToken);
console.log(`listening at ws://localhost:${config.port}/ws...`);