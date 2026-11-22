import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { DeviceRole, Kind, Topics, decode, encode, newEnvelope, SequenceCounter, type Envelope } from "@miobots/protocol";

process.env.PORT = "45911";
process.env.DEV_TOKEN = "test-dev-token";

let serverModule: typeof import("../../../src/brain/server.ts");

function getPort(): number {
    const addr = serverModule?.wss?.address();
    if (addr && typeof addr !== "string") return addr.port;
    return 45911;
}

/**
 * ENVELOPE.md §8: a dialer keeps each event until the Brain confirms it with `ACK sys.receipt`,
 * and re-sends anything unconfirmed after it reconnects. Without receipts the robot's outbox
 * could never be trimmed.
 */
describe("Event receipts (H3.2)", () => {
    beforeAll(async () => {
        serverModule = await import("../../../src/brain/server.ts");
        await new Promise((r) => setTimeout(r, 150));
    });

    afterAll(() => {
        serverModule.devices.clear();
        serverModule.deviceSeq.clear();
        serverModule.deviceRoles.clear();
    });

    async function connectHeart(deviceId: string): Promise<{ ws: WebSocket; seq: SequenceCounter; received: Envelope[] }> {
        const ws = new WebSocket(`ws://127.0.0.1:${getPort()}/ws`);
        const seq = new SequenceCounter();
        const received: Envelope[] = [];
        ws.on("message", (raw: Buffer) => received.push(decode(raw) as Envelope));
        await new Promise<void>((resolve) => ws.once("open", () => resolve()));
        ws.send(encode(newEnvelope({
            kind: Kind.CMD,
            topic: Topics.SYS_HELLO,
            payload: { device_id: deviceId, token: serverModule.configuredToken(), protocol_version: 1, role: DeviceRole.HEART },
            seq,
        })));
        await new Promise((r) => setTimeout(r, 120));
        return { ws, seq, received };
    }

    const receipts = (received: Envelope[]) =>
        received.filter((e) => e.kind === Kind.ACK && e.topic === Topics.SYS_RECEIPT).map((e) => (e.payload as { msg_ids: string[] }).msg_ids);

    it("confirms an event by its msg_id, and confirms a re-sent copy without acting on it twice", async () => {
        const { ws, seq, received } = await connectHeart("receipt-heart");
        const log = vi.spyOn(console, "log");
        const result = newEnvelope({
            kind: Kind.EVT,
            topic: Topics.NAV_RESULT,
            corr_id: "no-such-goal",
            payload: { success: true, total_time_s: 3, final_pose: { x: 1, y: 0, yaw: 0 } },
            seq,
        });
        ws.send(encode(result));
        // The same event after a reconnect: same msg_id and clocks, a fresh seq (ENVELOPE §8).
        ws.send(encode({ ...result, seq: seq.next() }));
        await new Promise((r) => setTimeout(r, 150));

        expect(receipts(received)).toEqual([[result.msg_id], [result.msg_id]]);
        const handled = log.mock.calls.filter((args: unknown[]) => String(args[0]).includes("unmatched result"));
        expect(handled.length).toBe(1);
        log.mockRestore();
        ws.close();
    });

    it("never confirms what does not wait in an outbox", async () => {
        const { ws, seq, received } = await connectHeart("receipt-heart-2");
        ws.send(encode(newEnvelope({ kind: Kind.EVT, topic: Topics.SYS_HEARTBEAT, payload: { status: "ok", t_wall_ms: Date.now() }, seq })));
        ws.send(encode(newEnvelope({ kind: Kind.TELEM, topic: Topics.STATE_POSE, payload: { x: 0, y: 0, yaw: 0, confidence: 1 }, seq })));
        await new Promise((r) => setTimeout(r, 150));

        expect(receipts(received)).toEqual([]);
        ws.close();
    });
});
