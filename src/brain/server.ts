import http from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
    createAck,
    createWelcomeAck,
    encode,
    Kind,
    Language,
    parse,
    Topics,
    validateHello,
    SequenceCounter,
    ProtocolDefaults,
    DeviceRole,
    newEnvelope,
    type HelloPayload,
    type CapabilityManifestPayload,
} from "@miobots/protocol";
import { config } from "./config.ts";
import { createHeartbeat, handleAck, handleHeartBeat, sendCommand } from "./hub.ts";
import { deviceCommands } from "./command-store.ts";
import { resetSequence, checkSequence } from "./sequence-tracker.ts";
import { runAgentLoop } from "./agent.ts";
import { devices, deviceSeq } from "./devices.ts";

export { devices, deviceSeq };

/**
 * Which registry slot each connection occupies.
 *
 * ENVELOPE.md §8: "`role` is one of heart · synapse · ganglion. It tells the hub which registry
 * slot a connection occupies without inferring it from the device id." The hub read `role` off
 * sys.hello and threw it away, so it had no way to tell a robot from an app.
 */
export const deviceRoles = new Map<string, DeviceRole>();

/**
 * Last capability manifest seen from each device.
 *
 * The manifest was logged and dropped, so Synapse — which renders its entire UI from it — had no
 * way to receive it at all (TASK_LEDGER.md:500 flags this as blocking I2). Caching also means a
 * freshly-connected app is not blank until the next publish tick.
 */
export const latestManifests = new Map<string, CapabilityManifestPayload>();

/** Sends one envelope to a device on that device's own outbound counter. */
function sendTo<TTopic extends string, TPayload>(
    targetId: string,
    topic: TTopic,
    payload: TPayload,
): void {
    const target = devices.get(targetId);
    const targetSeq = deviceSeq.get(targetId);
    if (!target || !targetSeq || target.readyState !== target.OPEN) return;

    target.send(
        encode(
            newEnvelope({
                kind: Kind.EVT,
                topic,
                payload: payload as never,
                seq: targetSeq,
            }),
        ),
    );
}

/** Forwards a manifest to every connected app. Heart publishes it; Synapse renders it. */
export function relayManifestToApps(payload: CapabilityManifestPayload): void {
    for (const [id, role] of deviceRoles) {
        if (role === DeviceRole.SYNAPSE) {
            sendTo(id, Topics.CAP_MANIFEST, payload);
        }
    }
}

export const httpServer = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    if (req.method === "POST" && req.url === "/dev/utterance") {
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
            const badRequest = (error: string) => {
                res.writeHead(400);
                res.end(JSON.stringify({ error, status: "error" }));
            };

            let parsed: unknown;
            try {
                parsed = JSON.parse(body || "{}");
            } catch {
                return badRequest("Malformed JSON body");
            }
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                return badRequest("Body must be a JSON object");
            }
            const { text, device_id, session_id, user_id } = parsed as Record<string, unknown>;

            if (typeof text !== "string" || text.trim().length === 0) {
                return badRequest("Missing or invalid 'text' field");
            }
            for (const [field, value] of Object.entries({ device_id, session_id, user_id })) {
                if (value !== undefined && typeof value !== "string") {
                    return badRequest(`'${field}' must be a string`);
                }
            }

            const targetDeviceId =
                (device_id as string | undefined) ?? (devices.keys().next().value || "heart-sim-01");
            const sessionId = session_id as string | undefined;
            const userId = user_id as string | undefined;

            try {
                const response = await runAgentLoop({
                    text: text.trim(),
                    deviceId: targetDeviceId,
                    sessionId,
                    userId,
                });

                const isTimeout = response.error?.includes("timed out") ?? false;
                res.writeHead(response.ok ? 200 : isTimeout ? 504 : 500);
                res.end(JSON.stringify(response));
            } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                res.writeHead(500);
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
    // Created per socket, before the handshake: even a rejection ACK counts on this connection.
    const outboundSeq = new SequenceCounter();

    // ENVELOPE.md §8: heartbeats flow both directions every 5 s, and three missed beats mean the
    // link is dead. The Brain previously did neither — it only echoed, so a device that stopped
    // talking while holding the socket open stayed registered and kept receiving commands that
    // could never be ACKed.
    let lastBeatFromDeviceMs = Date.now();
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    function stopHeartbeat(): void {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
        }
    }

    function startHeartbeat(): void {
        stopHeartbeat();
        lastBeatFromDeviceMs = Date.now();

        heartbeatTimer = setInterval(() => {
            if (ws.readyState !== ws.OPEN) {
                stopHeartbeat();
                return;
            }

            ws.send(encode(createHeartbeat(outboundSeq)));

            const silentFor = Date.now() - lastBeatFromDeviceMs;
            if (silentFor >= ProtocolDefaults.HEARTBEAT_TIMEOUT_MS) {
                console.log(
                    `[SERVER] Dead link: no heartbeat from ${deviceId} for ` +
                    `${(silentFor / 1000).toFixed(1)}s ` +
                    `(>= ${ProtocolDefaults.HEARTBEAT_MISSED_THRESHOLD} missed beats). Closing.`
                );
                stopHeartbeat();
                ws.close();
            }
        }, ProtocolDefaults.HEARTBEAT_INTERVAL_MS);
        heartbeatTimer.unref?.();
    }

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

        // ENVELOPE.md §6: "Past it, the receiver rejects with reason `expired` and logs it."
        // Dropping it silently left the sender waiting for an ACK that was never coming, which
        // reads as a timeout rather than as the refusal it actually is.
        if (envelope.expires_at && Date.now() >= envelope.expires_at) {
            console.log(
                `[SERVER] Expired command received: topic=${envelope.topic} corr_id=${envelope.corr_id}`
            );
            ws.send(
                encode(
                    createAck(
                        envelope,
                        { accepted: false, reason: "expired" },
                        outboundSeq
                    )
                )
            );
            return;
        }

        if (envelope.topic === Topics.SYS_HELLO) {
            const validation = validateHello(envelope.payload);
            if (!validation.valid) {
                const badWelcome = createWelcomeAck(envelope, {
                    accepted: false,
                    reason: "invalid payload",
                    seq: outboundSeq,
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
                    seq: outboundSeq,
                });
                ws.send(encode(badWelcome));
                console.log(`[SERVER] BAD DEV_TOKEN closing client`);
                ws.close();
                return;
            }

            deviceId = hello.device_id;
            devices.set(deviceId, ws);
            deviceSeq.set(deviceId, outboundSeq);
            deviceRoles.set(deviceId, hello.role);
            if (!deviceCommands.has(deviceId)) {
                deviceCommands.set(deviceId, new Map());
            }

            console.log(`[SERVER] Device authenticated: ${deviceId}`);
            const welcome = createWelcomeAck(envelope, { accepted: true, seq: outboundSeq });
            ws.send(encode(welcome));
            console.log(`[SERVER] welcome Ack Sent`);
            startHeartbeat();

            // An app that has just connected should not stare at a blank screen until the next
            // publish tick, so replay what we already know.
            if (hello.role === DeviceRole.SYNAPSE) {
                for (const cached of latestManifests.values()) {
                    sendTo(deviceId, Topics.CAP_MANIFEST, cached);
                }
            }
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
        if (envelope.kind === Kind.EVT && envelope.topic === Topics.SYS_HEARTBEAT) {
            // Liveness is recorded, not answered. The outbound beat is on its own timer.
            if (handleHeartBeat(envelope)) {
                lastBeatFromDeviceMs = Date.now();
            }
        }
        if (envelope.kind === Kind.EVT && envelope.topic === Topics.CAP_MANIFEST) {
            const manifest = envelope.payload as CapabilityManifestPayload;
            console.log(
                `[SERVER] Capability manifest received from ${deviceId}:`,
                JSON.stringify(manifest)
            );
            latestManifests.set(deviceId, manifest);
            relayManifestToApps(manifest);
        }
    });

    ws.on("close", () => {
        stopHeartbeat();
        if (deviceId) {
            resetSequence(deviceId);
            devices.delete(deviceId);
            deviceSeq.delete(deviceId);
            deviceRoles.delete(deviceId);
            // The manifest is deliberately kept: an app must be able to show last-known state
            // with a staleness marker when the robot is off (TASKS.md S1.2, third row).
            console.log(`[SERVER] Device disconnected: ${deviceId}`);
        }
    });

    ws.on("error", (error) => {
        console.log(`[SERVER] WebSocket error: ${error}`);
    });
});

/** The dev token this server is actually running with — see getPort() in the test suites. */
export function configuredToken(): string {
    return config.devToken;
}

export function startServer(
    port: number = config.port,
    devToken: string = config.devToken,
    host: string = config.host,
) {
    if (devToken) {
        config.devToken = devToken;
    }
    if (!httpServer.listening) {
        httpServer.listen(port, host, () => {
            console.log(`listening at ws://${host}:${port}/ws (HTTP on ${host}:${port})...`);
        });
    }
}

startServer(config.port, config.devToken, config.host);