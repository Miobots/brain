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

export const wss = new WebSocketServer({
    port: config.port,
    path: "/ws",
});

export const devices = new Map<string, WebSocket>();

export function startServer(port: number, dev_Token: string) {
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

            // handles oversized message B0.5 M-50
            if (byteLength > config.max_message_size) {
                console.log(
                    `[SERVER] Message exceeds maximum size ${config.max_message_size} bytes`
                );
                return;
            }

            const data = rawdata instanceof ArrayBuffer
                ? Buffer.from(rawdata)
                : Array.isArray(rawdata)
                ? Buffer.concat(rawdata)
                : rawdata;

            const brain_data = parse(data);
            if (!brain_data.success) {
                console.log(`[SERVER] Error: ${brain_data.error}`);
                return;
            }

            const envelope = brain_data.data;

            // Check if incoming command is expired (B0.5)
            if (envelope.expires_at && Date.now() >= envelope.expires_at) {
                console.log(
                    `[SERVER] Expired command received: topic=${envelope.topic} corr_id=${envelope.corr_id}`
                );
                return;
            }

            if (envelope.topic === Topics.SYS_HELLO) {
                const validation = validateHello(envelope.payload);
                if (!validation.valid) {
                    const bad_welcome = createWelcomeAck(envelope, {
                        accepted: false,
                        reason: "invalid payload",
                    });
                    ws.send(encode(bad_welcome));
                    console.log(
                        `[SERVER] Invalid hello: ${validation.error} closing client`
                    );
                    ws.close();
                    return;
                }

                const hello = envelope.payload as HelloPayload;
                console.log(`[SERVER] Verified hello payload`);

                // dev token check
                if (hello.token !== dev_Token) {
                    const bad_welcome = createWelcomeAck(envelope, {
                        accepted: false,
                        reason: "Unauthenticated token",
                    });
                    ws.send(encode(bad_welcome));
                    console.log(`[SERVER] BAD DEV_TOKEN closing client`);
                    ws.close();
                    return;
                }

                // Device authenticated
                deviceId = hello.device_id;
                devices.set(hello.device_id, ws);
                if (!deviceCommands.has(deviceId)) {
                    deviceCommands.set(deviceId, new Map());
                }
                console.log(`[SERVER] Device authenticated: ${deviceId}`);
                const welcome = createWelcomeAck(envelope, { accepted: true });
                ws.send(encode(welcome));
                console.log(`[SERVER] welcome Ack Sent`);
            }

            if (envelope.kind === Kind.ACK) {
                handleAck(envelope);
                return;
            }
        });

        ws.on("close", () => {
            if (deviceId) {
                devices.delete(deviceId);
                console.log(`[SERVER] Device disconnected: ${deviceId}`);
            }
        });

        ws.on("error", (err) => {
            console.log(`[SERVER] Websocket err: ${err}`);
        });
    });
}

startServer(config.port, config.devToken);
console.log(`listening at ws://localhost:${config.port}/ws...`);