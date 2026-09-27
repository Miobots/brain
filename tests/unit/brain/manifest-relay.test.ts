import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { brainManifest } from "../../../src/brain/capabilities.ts";
import {
    DeviceRole,
    Kind,
    Topics,
    decode,
    encode,
    newEnvelope,
    SequenceCounter,
    HeartCapabilities,
    BrainCapabilities,
    type CapabilityManifestPayload,
} from "@miobots/protocol";

const port = 45899;
const token = "test-dev-token";
process.env.PORT = String(port);
process.env.DEV_TOKEN = token;

let serverModule: typeof import("../../../src/brain/server.ts");

/**
 * server.ts listens at import time, so when several suites share a process the first import wins
 * the port. Ask the socket where it actually is rather than assuming — same helper shape the
 * other suites already use.
 */
function getPort(): number {
    const addr = serverModule?.wss?.address();
    if (addr && typeof addr !== "string") return addr.port;
    return port;
}

/**
 * The Brain logged cap.manifest and dropped it, so Synapse — which renders its entire UI from the
 * manifest — had no way to receive it at all. TASK_LEDGER.md:500 flags this as blocking I2.
 *
 * ENVELOPE.md §8 also says `role` "tells the hub which registry slot a connection occupies". The
 * hub read it off sys.hello and threw it away, so it could not tell a robot from an app.
 */
describe("Capability manifest relay", () => {
    const manifest: CapabilityManifestPayload = {
        capabilities: {
            [HeartCapabilities.DRIVING]: { state: "available" },
            [HeartCapabilities.DOCKING]: { state: "unavailable", reason: "no dock in the map yet" },
            [HeartCapabilities.LOCAL_VOICE]: { state: "degraded", note: "offline — simple phrasing only" },
        },
    };

    beforeAll(async () => {
        serverModule = await import("../../../src/brain/server.ts");
        await new Promise((r) => setTimeout(r, 150));
    });

    afterAll(() => {
        serverModule.devices.clear();
        serverModule.deviceSeq.clear();
        serverModule.deviceRoles.clear();
        serverModule.latestManifests.clear();
    });

    async function connectAs(deviceId: string, role: DeviceRole): Promise<WebSocket> {
        const ws = new WebSocket(`ws://127.0.0.1:${getPort()}/ws`);
        const seq = new SequenceCounter();
        await new Promise<void>((resolve) => ws.once("open", () => resolve()));
        ws.send(
            encode(
                newEnvelope({
                    kind: Kind.CMD,
                    topic: Topics.SYS_HELLO,
                    payload: { device_id: deviceId, token: serverModule.configuredToken(), protocol_version: 1, role },
                    seq,
                }),
            ),
        );
        await new Promise((r) => setTimeout(r, 120));
        return ws;
    }

    /** Next manifest from the Heart's half — the Brain's own half is interleaved on the same topic. */
    function nextManifest(ws: WebSocket, timeoutMs = 1500): Promise<CapabilityManifestPayload> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no manifest relayed")), timeoutMs);
            const onMessage = (raw: Buffer) => {
                const env = decode(raw) as unknown as Record<string, any>;
                if (env.topic === Topics.CAP_MANIFEST && !(BrainCapabilities.MEMORY in env.payload.capabilities)) {
                    clearTimeout(timer);
                    ws.off("message", onMessage);
                    resolve(env.payload as CapabilityManifestPayload);
                }
            };
            ws.on("message", onMessage);
        });
    }

    function publishManifest(heart: WebSocket, seq: SequenceCounter) {
        heart.send(
            encode(
                newEnvelope({
                    kind: Kind.EVT,
                    topic: Topics.CAP_MANIFEST,
                    payload: manifest,
                    seq,
                }),
            ),
        );
    }

    it("records each connection's role instead of discarding it", async () => {
        const heart = await connectAs("relay-heart", DeviceRole.HEART);
        const app = await connectAs("relay-app", DeviceRole.SYNAPSE);

        expect(serverModule.deviceRoles.get("relay-heart")).toBe(DeviceRole.HEART);
        expect(serverModule.deviceRoles.get("relay-app")).toBe(DeviceRole.SYNAPSE);

        heart.close();
        app.close();
    });

    it("forwards a manifest published by the Heart to a connected app", async () => {
        const app = await connectAs("relay-app-2", DeviceRole.SYNAPSE);
        const heart = await connectAs("relay-heart-2", DeviceRole.HEART);

        const relayed = nextManifest(app);
        publishManifest(heart, new SequenceCounter(50));

        const payload = await relayed;

        // The reasons and notes must survive the hop — the app renders them verbatim.
        expect(payload.capabilities[HeartCapabilities.DOCKING]).toEqual({
            state: "unavailable",
            reason: "no dock in the map yet",
        });
        expect(payload.capabilities[HeartCapabilities.LOCAL_VOICE]).toEqual({
            state: "degraded",
            note: "offline — simple phrasing only",
        });

        heart.close();
        app.close();
    });

    it("replays the cached manifest to an app that connects later", async () => {
        const heart = await connectAs("relay-heart-3", DeviceRole.HEART);
        publishManifest(heart, new SequenceCounter(80));
        await new Promise((r) => setTimeout(r, 150));

        // The app arrives after the publish. Without the cache it would show nothing until the
        // next tick, which is 10s away.
        const app = new WebSocket(`ws://127.0.0.1:${getPort()}/ws`);
        const seq = new SequenceCounter();
        await new Promise<void>((resolve) => app.once("open", () => resolve()));
        const relayed = nextManifest(app);
        app.send(
            encode(
                newEnvelope({
                    kind: Kind.CMD,
                    topic: Topics.SYS_HELLO,
                    payload: { device_id: "relay-app-3", token: serverModule.configuredToken(), protocol_version: 1, role: DeviceRole.SYNAPSE },
                    seq,
                }),
            ),
        );

        await expect(relayed).resolves.toBeDefined();

        heart.close();
        app.close();
    });

    it("keeps the last-known manifest after the robot disconnects", async () => {
        const heart = await connectAs("relay-heart-4", DeviceRole.HEART);
        publishManifest(heart, new SequenceCounter(90));
        await new Promise((r) => setTimeout(r, 150));

        heart.close();
        await new Promise((r) => setTimeout(r, 200));

        // TASKS.md S1.2 row 3: robot off, app still useful — it shows last-known state.
        expect(serverModule.latestManifests.get("relay-heart-4")).toBeDefined();
        expect(serverModule.deviceRoles.has("relay-heart-4")).toBe(false);
    });

    /** Every manifest that arrives within `windowMs`. */
    async function manifestsWithin(ws: WebSocket, windowMs: number): Promise<CapabilityManifestPayload[]> {
        const seen: CapabilityManifestPayload[] = [];
        const onMessage = (raw: Buffer) => {
            const env = decode(raw) as unknown as Record<string, any>;
            if (env.topic === Topics.CAP_MANIFEST) seen.push(env.payload);
        };
        ws.on("message", onMessage);
        await new Promise((r) => setTimeout(r, windowMs));
        ws.off("message", onMessage);
        return seen;
    }

    async function helloAsApp(deviceId: string): Promise<WebSocket> {
        const app = new WebSocket(`ws://127.0.0.1:${getPort()}/ws`);
        await new Promise<void>((resolve) => app.once("open", () => resolve()));
        app.send(
            encode(
                newEnvelope({
                    kind: Kind.CMD,
                    topic: Topics.SYS_HELLO,
                    payload: { device_id: deviceId, token: serverModule.configuredToken(), protocol_version: 1, role: DeviceRole.SYNAPSE },
                    seq: new SequenceCounter(),
                }),
            ),
        );
        return app;
    }

    it("sends the Brain's own half to an app as soon as it connects", async () => {
        // S1.2 row 3 is unreachable without this: the app could never tell "Brain up, robot off".
        const app = await helloAsApp("relay-app-5");
        const seen = await manifestsWithin(app, 300);

        const brainHalf = seen.find((m) => BrainCapabilities.MEMORY in m.capabilities);
        expect(brainHalf).toBeDefined();
        expect(Object.keys(brainHalf!.capabilities).sort()).toEqual(
            Object.values(BrainCapabilities).sort(),
        );

        app.close();
    });

    it("does not replay a robot that has since disconnected", async () => {
        const heart = await connectAs("relay-heart-6", DeviceRole.HEART);
        publishManifest(heart, new SequenceCounter(95));
        await new Promise((r) => setTimeout(r, 150));
        heart.close();
        await new Promise((r) => setTimeout(r, 200));

        // Replaying it would stamp the robot fresh, and the app would show it available for 30 s.
        const app = await helloAsApp("relay-app-6");
        const seen = await manifestsWithin(app, 300);

        expect(seen.some((m) => HeartCapabilities.DRIVING in m.capabilities)).toBe(false);
        app.close();
    });
});

describe("The Brain's half of the manifest", () => {
    it("says why each capability it cannot back is unavailable", () => {
        const manifest = brainManifest([DeviceRole.HEART]);
        for (const status of Object.values(manifest.capabilities)) {
            if (status.state === "unavailable") expect(status.reason).toBeTruthy();
        }
        expect(manifest.capabilities[BrainCapabilities.LAPTOP_DAEMON]!.state).toBe("unavailable");
    });

    it("reports the laptop daemon available only while Ganglion is connected", () => {
        const manifest = brainManifest([DeviceRole.HEART, DeviceRole.GANGLION]);
        expect(manifest.capabilities[BrainCapabilities.LAPTOP_DAEMON]).toEqual({ state: "available" });
    });
});
