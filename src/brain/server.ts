import http from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
    createWelcomeAck,
    encode,
    Kind,
    Language,
    parse,
    Topics,
    validateHello,
    type HelloPayload,
} from "@miobots/protocol";
import { config } from "./config.ts";
import { handleAck, sendCommand } from "./hub.ts";
import { deviceCommands } from "./command-store.ts";
import { resetSequence, checkSequence } from "./sequence-tracker.ts";

export const devices = new Map<string, WebSocket>();

export const httpServer = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    if (req.method === "POST" && req.url === "/dev/speak") {
        let body = "";
        let bodyLength = 0;

        req.on("data", (chunk: Buffer) => {
            bodyLength += chunk.length;
            if (bodyLength > config.max_message_size) {
                res.writeHead(413);
                res.end(JSON.stringify({ error: "Payload too large", status: "error" }));
                req.destroy();
                return;
            }
            body += chunk.toString("utf-8");
        });

        req.on("end", async () => {
            try {
                const parsed = JSON.parse(body || "{}");
                const text = parsed.text;
                const lang = parsed.lang ?? Language.EN;
                const priority = parsed.priority ?? "normal";
                const targetDeviceId = parsed.device_id ?? (devices.keys().next().value || "heart-sim-01");

                if (typeof text !== "string" || text.trim().length === 0) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Missing or invalid 'text' field", status: "error" }));
                    return;
                }

                if (!devices.has(targetDeviceId)) {
                    res.writeHead(503);
                    res.end(
                        JSON.stringify({
                            error: `Device '${targetDeviceId}' is not connected`,
                            status: "error",
                        })
                    );
                    return;
                }

                const ack = await sendCommand(targetDeviceId, Topics.VOICE_SPEAK, {
                    text,
                    lang,
                    priority,
                });

                res.writeHead(200);
                res.end(
                    JSON.stringify({
                        status: "acknowledged",
                        ack,
                    })
                );
            } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                const isTimeout = errorMessage.includes("timed out");
                res.writeHead(isTimeout ? 504 : 500);
                res.end(
                    JSON.stringify({
                        status: "error",
                        error: errorMessage,
                    })
                );
            }
        });
        return;
    }

    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200);
        res.end(
            JSON.stringify({
                status: "ok",
                connected_devices: Array.from(devices.keys()),
            })
        );
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
});

export const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
});

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
            console.log(
                `[SERVER] Message exceeds maximum size ${config.max_message_size} bytes`
            );
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
                const badWelcome = createWelcomeAck(envelope, {
                    accepted: false,
                    reason: "invalid payload",
                });
                ws.send(encode(badWelcome));
                console.log(
                    `[SERVER] Invalid hello: ${validation.error} closing client`
                );
                ws.close();
                return;
            }

            const hello = envelope.payload as HelloPayload;
            if (hello.token !== config.devToken) {
                const badWelcome = createWelcomeAck(envelope, {
                    accepted: false,
                    reason: "Unauthenticated token",
                });
                ws.send(encode(badWelcome));
                console.log(`[SERVER] BAD DEV_TOKEN closing client`);
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

        if (!checkSequence(deviceId, envelope.seq, envelope.kind)) {
            return;
        }

        if (envelope.kind === Kind.ACK) {
            handleAck(envelope);
        }
    });

    ws.on("close", () => {
        if (deviceId) {
            resetSequence(deviceId);
            devices.delete(deviceId);
            console.log(`[SERVER] Device disconnected: ${deviceId}`);
        }
    });

    ws.on("error", (error) => {
        console.log(`[SERVER] WebSocket error: ${error}`);
    });
});

export function startServer(port: number = config.port, devToken: string = config.devToken) {
    if (devToken) {
        config.devToken = devToken;
    }
    if (!httpServer.listening) {
        httpServer.listen(port, () => {
            console.log(`listening at ws://localhost:${port}/ws (HTTP on port ${port})...`);
        });
    }
}

startServer(config.port, config.devToken);