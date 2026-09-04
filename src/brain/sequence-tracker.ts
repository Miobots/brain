import { Kind, SequenceGapDetector } from "@miobots/protocol";

const detectors = new Map<string, SequenceGapDetector>();

export function resetSequence(deviceId: string): void {
    detectors.delete(deviceId);
}

export function checkSequence(
    deviceId: string,
    seq: number,
    kind: Kind = Kind.EVT,
): boolean {
    let detector = detectors.get(deviceId);
    if (!detector) {
        detector = new SequenceGapDetector();
        detectors.set(deviceId, detector);
    }

    const result = detector.evaluate(seq, kind);

    if (result.gap) {
        console.warn(
            `[SERVER] SEQUENCE GAP: device=${deviceId} ` +
            `expected=${result.expectedSeq} received=${result.receivedSeq}` +
            (result.gapSize > 0 ? ` (missing ${result.gapSize} message(s))` : ""),
        );
    }

    if (result.droppedOldTelemetry) {
        console.warn(
            `[SERVER] STALE TELEMETRY: device=${deviceId} ` +
            `expected=${result.expectedSeq} received=${result.receivedSeq}`,
        );
        return false;
    }

    if (seq < result.expectedSeq && !result.droppedOldTelemetry) {
        console.warn(
            `[SERVER] OUT-OF-ORDER MESSAGE: device=${deviceId} ` +
            `expected=${result.expectedSeq} received=${seq}`,
        );
    }

    return true;
}

// Backwards compatibility aliases
export const resetSequencebrain = resetSequence;
export const checksequence = checkSequence;