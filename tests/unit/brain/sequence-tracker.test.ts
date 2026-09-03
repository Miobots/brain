import { afterEach, describe, expect, it, vi } from "vitest";
import { checksequence, resetSequencebrain } from "../../../src/brain/sequence-tracker.ts";

describe("sequence tracker", () => {
    const deviceId = "heart-sequence-test";

    afterEach(() => {
        resetSequencebrain(deviceId);
        vi.restoreAllMocks();
    });

    it("accepts the first message and the next message in sequence", () => {
        expect(checksequence(deviceId, 6)).toBe(true);
        expect(checksequence(deviceId, 7)).toBe(true);
    });

    it("accepts a gap and continues from the received sequence", () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(checksequence(deviceId, 6)).toBe(true);
        expect(checksequence(deviceId, 8)).toBe(true);
        expect(checksequence(deviceId, 9)).toBe(true);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("expected=7 received=8"),
        );
    });

    it("rejects an older out-of-order message", () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(checksequence(deviceId, 6)).toBe(true);
        expect(checksequence(deviceId, 5)).toBe(false);
        expect(checksequence(deviceId, 7)).toBe(true);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("expected=7 received=5"),
        );
    });

    it("starts a fresh sequence after reset", () => {
        expect(checksequence(deviceId, 10)).toBe(true);
        resetSequencebrain(deviceId);

        expect(checksequence(deviceId, 1)).toBe(true);
    });
});