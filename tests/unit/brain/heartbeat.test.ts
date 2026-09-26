import { beforeAll, describe, expect, it } from "vitest";
import {
    Kind,
    Topics,
    SystemHealth,
    SequenceCounter,
    newEnvelope,
    type HeartbeatPayload,
} from "@miobots/protocol";

// This file simulates one client connection, so one outbound counter (ENVELOPE.md §6).
const clientSeq = new SequenceCounter();

/**
 * ENVELOPE.md §8:
 *   4. EVT sys.heartbeat every 5s, both directions
 *   5. three missed heartbeats -> treat as dead, close, reconnect
 *
 * The Brain did neither. It only echoed an inbound beat, which makes its own liveness depend on
 * the peer still talking — exactly the case step 5 exists to catch.
 */
describe("Brain heartbeat (ENVELOPE.md §8)", () => {
    let hubModule: typeof import("../../../src/brain/hub.ts");

    beforeAll(async () => {
        hubModule = await import("../../../src/brain/hub.ts");
    });

    describe("outbound — the Brain announces its own liveness", () => {
        it("builds a sys.heartbeat EVT on the connection's own counter", () => {
            const conn = new SequenceCounter();

            const first = hubModule.createHeartbeat(conn);
            const second = hubModule.createHeartbeat(conn);

            expect(first.kind).toBe(Kind.EVT);
            expect(first.topic).toBe(Topics.SYS_HEARTBEAT);
            expect(first.payload.status).toBe(SystemHealth.OK);
            expect(typeof first.payload.t_wall_ms).toBe("number");

            // Counts on this connection, not a shared one.
            expect([first.seq, second.seq]).toEqual([1, 2]);
        });

        it("keeps two connections' beats independent", () => {
            const a = new SequenceCounter();
            const b = new SequenceCounter();

            hubModule.createHeartbeat(a);
            const bBeat = hubModule.createHeartbeat(b);

            expect(bBeat.seq).toBe(1);
        });
    });

    describe("inbound — validation feeds the watchdog", () => {
        function inboundBeat(payload: unknown) {
            return newEnvelope({
                kind: Kind.EVT,
                topic: Topics.SYS_HEARTBEAT,
                payload: payload as HeartbeatPayload,
                seq: clientSeq,
            });
        }

        it("returns the payload for a well-formed beat", () => {
            const result = hubModule.handleHeartBeat(
                inboundBeat({ status: SystemHealth.OK, t_wall_ms: Date.now() }),
            );

            expect(result).toBeDefined();
            expect(result!.status).toBe(SystemHealth.OK);
        });

        it("rejects a beat with an unknown status", () => {
            expect(
                hubModule.handleHeartBeat(inboundBeat({ status: "vibing", t_wall_ms: Date.now() })),
            ).toBeUndefined();
        });

        it("rejects a beat missing t_wall_ms", () => {
            expect(hubModule.handleHeartBeat(inboundBeat({ status: SystemHealth.OK }))).toBeUndefined();
        });

        it("rejects a non-object payload rather than throwing", () => {
            expect(hubModule.handleHeartBeat(inboundBeat("ok"))).toBeUndefined();
            expect(hubModule.handleHeartBeat(inboundBeat(null))).toBeUndefined();
        });

        it("does not reply — the outbound direction is on its own timer", () => {
            // Guards the regression: echoing makes the Brain look alive only while the peer talks.
            const result = hubModule.handleHeartBeat(
                inboundBeat({ status: SystemHealth.OK, t_wall_ms: Date.now() }),
            );

            expect(result).not.toHaveProperty("kind");
            expect(result).not.toHaveProperty("topic");
        });
    });
});
