import { describe, it, expect, vi, afterEach } from "vitest";
import { BrainCapabilities, HeartCapabilities, Kind, Topics, type CapabilityManifestPayload } from "@miobots/protocol";
import { describeSituation, recordBattery, robotSituations } from "../../../src/brain/context.ts";
import { activeNavigationGoals, handleNavigationResult } from "../../../src/brain/navigation.ts";
import { runAgentLoop } from "../../../src/brain/agent.ts";
import * as aiClient from "../../../src/ai/client.ts";

const robot: CapabilityManifestPayload = {
    capabilities: {
        [HeartCapabilities.DRIVING]: { state: "available" },
        [HeartCapabilities.LOCAL_VOICE]: { state: "available" },
    },
};
const brain: CapabilityManifestPayload = {
    capabilities: {
        [BrainCapabilities.SMART_HOME]: { state: "unavailable", reason: "Home Assistant unreachable" },
    },
};

describe("Situation context (B2.3)", () => {
    afterEach(() => {
        robotSituations.clear();
        activeNavigationGoals.clear();
        vi.restoreAllMocks();
    });

    it("renders room, battery and capabilities as three lines", () => {
        expect(recordBattery("heart-1", { percentage: 68, voltage: 15.1, is_charging: false })).toBe(true);
        robotSituations.get("heart-1")!.room = "living_room";

        expect(describeSituation(robotSituations.get("heart-1"), { robot, brain })).toBe(
            "Current room: living_room · Battery: 68%, not charging\n" +
            "Available: driving, local-voice\n" +
            "Unavailable: smart-home (Home Assistant unreachable)",
        );
    });

    it("says so when the robot has reported nothing, rather than implying it can drive", () => {
        const text = describeSituation(undefined, { brain });
        expect(text).toContain("Current room: unknown · Battery: unknown");
        expect(text).toContain("robot capabilities (the robot has not reported any");
    });

    it("rejects a malformed state.battery payload", () => {
        expect(recordBattery("heart-1", { percentage: "68" })).toBe(false);
        expect(robotSituations.get("heart-1")).toBeUndefined();
    });

    it("a successful drive sets the current room; a failed one does not", () => {
        activeNavigationGoals.set("heart-1:g-1", {
            device_id: "heart-1", goal_id: "g-1", corr_id: "c-1", region: "kitchen", status: "in_progress",
        });
        const result = (success: boolean, corr_id: string) => ({
            msg_id: "m", corr_id, t_mono_ns: "1", t_wall_ms: 1, kind: Kind.EVT, topic: Topics.NAV_RESULT, seq: 1,
            payload: { success, total_time_s: 3, final_pose: { x: 0, y: 0, yaw: 0 } },
        });

        handleNavigationResult("heart-1", result(true, "c-1"));
        expect(robotSituations.get("heart-1")?.room).toBe("kitchen");

        activeNavigationGoals.set("heart-1:g-2", {
            device_id: "heart-1", goal_id: "g-2", corr_id: "c-2", region: "bedroom", status: "in_progress",
        });
        handleNavigationResult("heart-1", result(false, "c-2"));
        expect(robotSituations.get("heart-1")?.room).toBe("kitchen");
    });

    it("puts the situation in the system prompt of every turn", async () => {
        const chat = vi.spyOn(aiClient, "chat").mockResolvedValue({
            ok: true, correlationId: "c", text: "Done.", files: [], finishReason: "stop",
            provider: "p", model: "m", capability: "fast",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 1,
        });

        await runAgentLoop({ text: "turn off the fan", situation: "Current room: living_room · Battery: 68%, not charging" });

        const system = chat.mock.calls[0]![0].messages[0]!;
        expect(system.role).toBe("system");
        expect(system.content).toContain("Current room: living_room");
        expect(system.content).toContain("current room without asking");
        expect(system.content).toContain("can't do it right now");
    });
});
