import type { BatteryPayload, CapabilityManifestPayload } from "@miobots/protocol";

/**
 * What the Brain knows about each robot *right now* (TASKS.md B2.3), fed to the agent before every
 * reply so "turn off the fan" means the fan in this room.
 *
 * The room is the last region a drive reached — no topic carries it yet (ENVELOPE.md §10), so it is
 * cleared when a drive starts rather than claimed while the robot is between rooms.
 */
export interface RobotSituation {
    room?: string;
    battery?: BatteryPayload;
}

export const robotSituations = new Map<string, RobotSituation>();

function situationOf(device_id: string): RobotSituation {
    let s = robotSituations.get(device_id);
    if (!s) robotSituations.set(device_id, (s = {}));
    return s;
}

export function recordRoom(device_id: string, room: string | undefined): void {
    situationOf(device_id).room = room;
}

/** `state.battery` telemetry. Validated here: the sender is a different language on a different machine. */
export function recordBattery(device_id: string, payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null) return false;
    const p = payload as Record<string, unknown>;
    if (typeof p.percentage !== "number" || typeof p.voltage !== "number" || typeof p.is_charging !== "boolean") {
        return false;
    }
    situationOf(device_id).battery = { percentage: p.percentage, voltage: p.voltage, is_charging: p.is_charging };
    return true;
}

/**
 * The three-line block appended to the system prompt. `manifests` is every half that currently
 * applies — the robot's, when connected, and the Brain's own. A missing robot half is said out
 * loud: an agent that assumes it can drive will plan a drive and hang.
 */
export function describeSituation(
    situation: RobotSituation | undefined,
    manifests: { robot?: CapabilityManifestPayload; brain: CapabilityManifestPayload },
): string {
    const battery = situation?.battery
        ? `${Math.round(situation.battery.percentage)}%, ${situation.battery.is_charging ? "charging" : "not charging"}`
        : "unknown";

    const available: string[] = [];
    const unavailable: string[] = [];
    for (const half of [manifests.robot, manifests.brain]) {
        for (const [id, status] of Object.entries(half?.capabilities ?? {})) {
            if (status.state === "available") available.push(id);
            else if (status.state === "degraded") available.push(`${id} (degraded: ${status.note ?? "reduced"})`);
            else unavailable.push(`${id} (${status.reason ?? "unavailable"})`);
        }
    }
    if (!manifests.robot) unavailable.push("robot capabilities (the robot has not reported any — it may be offline)");

    return [
        `Current room: ${situation?.room ?? "unknown"} · Battery: ${battery}`,
        `Available: ${available.join(", ") || "none"}`,
        `Unavailable: ${unavailable.join(", ") || "none"}`,
    ].join("\n");
}
