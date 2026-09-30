import { randomUUID } from "node:crypto";
import {
    type AckPayload,
    type Envelope,
    type NavFeedbackPayload,
    type NavGotoPayload,
    type NavResultPayload,
} from "@miobots/protocol";
import { Topics } from "@miobots/protocol";
import { sendCommand } from "./hub.ts";

export type NavigationStatus = "pending" | "in_progress" | "cancelling";

export type ActiveNavigation = {
    device_id: string;
    goal_id: string;
    corr_id: string;
    status: NavigationStatus;
    latest_feedback?: NavFeedbackPayload;
};

export const activeNavigationGoals = new Map<string, ActiveNavigation>();

export class NavigationRefusalError extends Error {
    public readonly reason: string;
    public readonly details: Record<string, unknown>;
    public readonly userMessage: string;

    constructor(reason: string, details: Record<string, unknown> = {}) {
        super(`Heart refused nav.goto: ${reason}`);
        this.name = "NavigationRefusalError";
        this.reason = reason;
        this.details = details;
        this.userMessage = refusalMessage(reason, details);
    }
}

function goalKey(device_id: string, goal_id: string): string {
    return `${device_id}:${goal_id}`;
}

function nextGoalId(): string {
    return `g-${randomUUID()}`;
}

export async function navigateTo(
    device_id: string,
    region: string,
): Promise<{ goal_id: string; status: "in_progress"; target_device: string; ack: AckPayload }> {
    const goal_id = nextGoalId();
    if (hasActiveGoal(device_id)) {
        throw new Error(`[NAV] A navigation goal is already active for ${device_id}`);
    }

    const pendingGoal: ActiveNavigation = {
        device_id,
        goal_id,
        corr_id: "",
        status: "pending",
    };
    activeNavigationGoals.set(goalKey(device_id, goal_id), pendingGoal);

    const payload: NavGotoPayload = { region, goal_id };
    try {
        const ack = await sendCommand(device_id, Topics.NAV_GOTO, payload);
        const ackPayload = asAckPayload(ack.payload);
        if (ackPayload?.accepted !== true) {
            throw new NavigationRefusalError(
                ackPayload?.reason ?? "unknown_reason",
                ackPayload?.details ?? {},
            );
        }

        pendingGoal.corr_id = ack.corr_id;
        pendingGoal.status = "in_progress";
        console.log(`[NAV] Goal started device=${device_id} goal_id=${goal_id}`);

        return { goal_id, status: "in_progress", target_device: device_id, ack: ackPayload };
    } catch (error) {
        if (activeNavigationGoals.get(goalKey(device_id, goal_id)) === pendingGoal) {
            activeNavigationGoals.delete(goalKey(device_id, goal_id));
        }
        throw error;
    }
}

export async function cancelNavigation(
    device_id: string | undefined,
    goal_id?: string,
): Promise<{ goal_id: string; status: "cancelling"; ack: AckPayload }> {
    const goal = findGoal(device_id, goal_id);
    if (!goal) {
        throw new Error(`[NAV] No active navigation goal${goal_id ? `: ${goal_id}` : ""}`);
    }
    if (goal.status === "cancelling") {
        return { goal_id: goal.goal_id, status: "cancelling", ack: { accepted: true } };
    }

    goal.status = "cancelling";
    try {
        const ack = await sendCommand(goal.device_id, Topics.NAV_CANCEL, { goal_id: goal.goal_id });
        const ackPayload = asAckPayload(ack.payload);
        if (ackPayload?.accepted !== true) {
            // Heart owns the past: if it has no such goal, neither do we (e.g. dropped on disconnect).
            if (ackPayload?.reason === "goal_not_found") {
                activeNavigationGoals.delete(goalKey(goal.device_id, goal.goal_id));
            } else {
                goal.status = "in_progress";
            }
            throw new Error(`Heart refused nav.cancel: ${ackPayload?.reason ?? "unknown_reason"}`);
        }

        console.log(`[NAV] Cancellation accepted device=${goal.device_id} goal_id=${goal.goal_id}`);
        return { goal_id: goal.goal_id, status: "cancelling", ack: ackPayload };
    } catch (error) {
        if (activeNavigationGoals.get(goalKey(goal.device_id, goal.goal_id)) === goal) {
            goal.status = "in_progress";
        }
        throw error;
    }
}

export function handleNavigationFeedback(
    device_id: string,
    event: Envelope<string, unknown>,
): boolean {
    const payload = event.payload;
    if (!isFeedbackPayload(payload)) {
        console.log("[NAV] Invalid nav.feedback payload");
        return false;
    }

    const goal = findGoalByCorrelation(device_id, event.corr_id);
    if (!goal) {
        console.log(`[NAV] Ignoring unmatched feedback corr_id=${event.corr_id}`);
        return false;
    }

    goal.latest_feedback = payload;
    console.log(
        `[NAV] Feedback device=${device_id} goal_id=${goal.goal_id} ` +
        `distance_remaining_m=${payload.distance_remaining_m}`,
    );
    return true;
}

export function handleNavigationResult(
    device_id: string,
    event: Envelope<string, unknown>,
): boolean {
    const payload = event.payload;
    if (!isResultPayload(payload)) {
        console.log("[NAV] Invalid nav.result payload");
        return false;
    }

    const goal = findGoalByCorrelation(device_id, event.corr_id);
    if (!goal) {
        console.log(`[NAV] Ignoring unmatched result corr_id=${event.corr_id}`);
        return false;
    }

    activeNavigationGoals.delete(goalKey(device_id, goal.goal_id));
    console.log(`[NAV] Result device=${device_id} goal_id=${goal.goal_id} success=${payload.success}`);
    return true;
}

export function hasActiveGoal(device_id: string): boolean {
    for (const goal of activeNavigationGoals.values()) {
        if (goal.device_id === device_id) return true;
    }
    return false;
}

function findGoal(device_id: string | undefined, goal_id?: string): ActiveNavigation | undefined {
    if (device_id && goal_id) return activeNavigationGoals.get(goalKey(device_id, goal_id));
    for (const goal of activeNavigationGoals.values()) {
        if ((!device_id || goal.device_id === device_id) && (!goal_id || goal.goal_id === goal_id)) return goal;
    }
    return undefined;
}

function findGoalByCorrelation(device_id: string, corr_id: string): ActiveNavigation | undefined {
    for (const goal of activeNavigationGoals.values()) {
        if (goal.device_id === device_id && goal.corr_id === corr_id) return goal;
    }
    return undefined;
}

export function clearNavigationForDevice(device_id: string): void {
    for (const [key, goal] of activeNavigationGoals) {
        if (goal.device_id === device_id) activeNavigationGoals.delete(key);
    }
}

function asAckPayload(payload: unknown): AckPayload | undefined {
    if (!isRecord(payload) || typeof payload.accepted !== "boolean") return undefined;
    return payload as unknown as AckPayload;
}

function isFeedbackPayload(payload: unknown): payload is NavFeedbackPayload {
    return isRecord(payload)
        && typeof payload.distance_remaining_m === "number"
        && typeof payload.estimated_time_remaining_s === "number";
}

function isResultPayload(payload: unknown): payload is NavResultPayload {
    return isRecord(payload)
        && typeof payload.success === "boolean"
        && typeof payload.total_time_s === "number"
        && isRecord(payload.final_pose)
        && typeof payload.final_pose.x === "number"
        && typeof payload.final_pose.y === "number"
        && typeof payload.final_pose.yaw === "number"
        && (payload.reason === undefined || typeof payload.reason === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusalMessage(reason: string, details: Record<string, unknown>): string {
    if (reason === "battery_below_return_margin" && typeof details.battery_pct === "number") {
        return `I can't go there right now — my battery is at ${details.battery_pct}% and I need enough charge to reach the dock.`;
    }
    if (reason === "active_fault") {
        return "I can't go there right now because the robot has an active fault.";
    }
    if (reason === "mid_docking") {
        return "I can't go there right now because the robot is currently docking.";
    }
    return `I can't go there right now (${reason.replaceAll("_", " ")}).`;
}
