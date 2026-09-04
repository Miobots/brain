import { afterEach, describe, expect, it, vi } from "vitest";
import { Kind } from "@miobots/protocol";
import { checkSequence, resetSequence } from "../../../src/brain/sequence-tracker.ts";

describe("sequence tracker", () => {
    const deviceId = "heart-sequence-test";

    afterEach(() => {
        resetSequence(deviceId);
        vi.restoreAllMocks();
    });

    it("accepts the first message and the next message in sequence", () => {
        expect(checkSequence(deviceId, 6)).toBe(true);
        expect(checkSequence(deviceId, 7)).toBe(true);
    });

    it("accepts a gap and continues from the received sequence", () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(checkSequence(deviceId, 6)).toBe(true);
        expect(checkSequence(deviceId, 8)).toBe(true);
        expect(checkSequence(deviceId, 9)).toBe(true);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("expected=7 received=8"),
        );
    });

    it("accepts an older out-of-order event but logs a warning", () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(checkSequence(deviceId, 6, Kind.EVT)).toBe(true);
        expect(checkSequence(deviceId, 5, Kind.EVT)).toBe(true);
        expect(checkSequence(deviceId, 7, Kind.EVT)).toBe(true);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("expected=7 received=5"),
        );
    });

    it("drops stale telemetry with older sequence", () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(checkSequence(deviceId, 6, Kind.TELEM)).toBe(true);
        expect(checkSequence(deviceId, 5, Kind.TELEM)).toBe(false);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("STALE TELEMETRY: device=heart-sequence-test"),
        );
    });

    it("starts a fresh sequence after reset", () => {
        expect(checkSequence(deviceId, 10)).toBe(true);
        resetSequence(deviceId);

        expect(checkSequence(deviceId, 1)).toBe(true);
    });
});