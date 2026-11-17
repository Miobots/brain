import { afterAll, beforeAll, expect, it } from "vitest";
import WebSocket from "ws";
import {
    createAck,
    decode,
    DeviceRole,
    encode,
    HeartCapabilities,
    Kind,
    newEnvelope,
    SequenceCounter,
    Topics,
} from "@miobots/protocol";

process.env.PORT = "45902";
process.env.DEV_TOKEN = "synapse-map-test-token";

let server: typeof import("../../../src/brain/server.ts");
const clients: WebSocket[] = [];

function next(ws: WebSocket, topic: string, kind?: Kind): Promise<ReturnType<typeof decode>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.off("message", onMessage);
            reject(new Error(`No ${topic} received`));
        }, 1500);
        const onMessage = (raw: WebSocket.RawData) => {
            const message = decode(raw as Buffer);
            if (message.topic !== topic || (kind && message.kind !== kind)) return;
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve(message);
        };
        ws.on("message", onMessage);
    });
}

async function connect(deviceId: string, role: DeviceRole) {
    const address = server.wss.address();
    const port = address && typeof address !== "string" ? address.port : 45902;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const seq = new SequenceCounter();
    clients.push(ws);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    const welcome = next(ws, Topics.SYS_WELCOME);
    ws.send(encode(newEnvelope({
        kind: Kind.CMD,
        topic: Topics.SYS_HELLO,
        payload: { device_id: deviceId, role, token: server.configuredToken(), protocol_version: 1 },
        seq,
    })));
    expect((await welcome).payload).toMatchObject({ accepted: true });
    return { ws, seq };
}

beforeAll(async () => {
    server = await import("../../../src/brain/server.ts");
    if (!server.wss.address()) await new Promise<void>((resolve) => server.wss.once("listening", resolve));
});

afterAll(() => {
    for (const ws of clients) ws.close();
    server.devices.clear();
    server.deviceSeq.clear();
});

it("relays Heart map telemetry and returns Heart's navigation ACK to Synapse", async () => {
    const app = await connect("map-app", DeviceRole.SYNAPSE);
    const heart = await connect("map-heart", DeviceRole.HEART);
    const robotManifest = next(app.ws, Topics.CAP_MANIFEST);
    heart.ws.send(encode(newEnvelope({
        kind: Kind.EVT,
        topic: Topics.CAP_MANIFEST,
        payload: { capabilities: { [HeartCapabilities.DRIVING]: { state: "available" } } },
        seq: heart.seq,
    })));
    await robotManifest;

    const mapReceived = next(app.ws, Topics.MAP_SNAPSHOT, Kind.TELEM);
    heart.ws.send(encode(newEnvelope({
        kind: Kind.TELEM,
        topic: Topics.MAP_SNAPSHOT,
        payload: { width: 2, height: 2, resolution: 0.5, origin: { x: 0, y: 0 }, cells: [1, 4] },
        seq: heart.seq,
    })));
    expect((await mapReceived).payload).toMatchObject({ width: 2, height: 2, cells: [1, 4] });

    const heartCommand = next(heart.ws, Topics.NAV_GOTO, Kind.CMD);
    const appAck = next(app.ws, Topics.NAV_GOTO, Kind.ACK);
    const request = newEnvelope({
        kind: Kind.CMD,
        topic: Topics.NAV_GOTO,
        payload: { goal_id: "map-goal", x: 0.75, y: 0.75 },
        seq: app.seq,
    });
    app.ws.send(encode(request));
    const received = await heartCommand;
    heart.ws.send(encode(createAck(received, { accepted: true }, heart.seq)));
    const ack = await appAck;
    expect(ack.corr_id).toBe(request.corr_id);
    expect(ack.payload).toMatchObject({ accepted: true });

    const invalidAck = next(app.ws, Topics.NAV_GOTO, Kind.ACK);
    app.ws.send(encode(newEnvelope({
        kind: Kind.CMD,
        topic: Topics.NAV_GOTO,
        payload: { goal_id: "missing-y", x: 1 } as never,
        seq: app.seq,
    })));
    expect((await invalidAck).payload).toMatchObject({ accepted: false, reason: "Invalid navigation goal." });

    await connect("map-heart-2", DeviceRole.HEART);
    const ambiguousAck = next(app.ws, Topics.NAV_GOTO, Kind.ACK);
    app.ws.send(encode(newEnvelope({
        kind: Kind.CMD,
        topic: Topics.NAV_GOTO,
        payload: { goal_id: "ambiguous-map", x: 1, y: 1 },
        seq: app.seq,
    })));
    expect((await ambiguousAck).payload).toMatchObject({
        accepted: false,
        reason: "Exactly one robot must be connected for map navigation.",
    });
});
