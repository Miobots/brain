import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createAck,
    decode,
    Kind,
    newEnvelope,
    SequenceCounter,
    type Envelope,
} from "@miobots/protocol";
import {
    activeNavigationGoals,
    cancelNavigation,
    clearNavigationForDevice,
    handleNavigationFeedback,
    handleNavigationResult,
    navigateTo,
    NavigationRefusalError,
} from "../../../src/brain/navigation.ts";
import { handleAck } from "../../../src/brain/hub.ts";
import { devices, deviceSeq } from "../../../src/brain/devices.ts";
import { deviceCommands } from "../../../src/brain/command-store.ts";

const deviceId = "heart-navigation-test";
const heartSeq = new SequenceCounter();

type MockConnection = { send: ReturnType<typeof vi.fn> };

function connectDevice(): MockConnection {
    const connection = { send: vi.fn() };
    devices.set(deviceId, connection as never);
    deviceSeq.set(deviceId, new SequenceCounter());
    return connection;
}

function decodeCommand(connection: MockConnection, index = 0): Envelope<string, unknown> {
    return decode(connection.send.mock.calls[index]![0]);
}

function navigationEvent(
    topic: string,
    corr_id: string,
    payload: unknown,
): Envelope<string, unknown> {
    return newEnvelope({
        kind: Kind.EVT,
        topic,
        corr_id,
        seq: heartSeq,
        payload: payload as never,
    });
}

afterEach(() => {
    clearNavigationForDevice(deviceId);
    devices.clear();
    deviceSeq.clear();
    deviceCommands.clear();
});

describe("Brain navigation lifecycle", () => {
    it("returns an in-progress goal after acceptance and tracks feedback", async () => {
        const connection = connectDevice();
        const started = navigateTo(deviceId, "kitchen");
        const command = decodeCommand(connection);

        handleAck(createAck(command, { accepted: true }, heartSeq));
        const result = await started;

        expect(result.status).toBe("in_progress");
        expect(result.goal_id).toMatch(/^g-/);
        const goal = activeNavigationGoals.get(`${deviceId}:${result.goal_id}`);
        expect(goal?.corr_id).toBe(command.corr_id);

        expect(handleNavigationFeedback(
            deviceId,
            navigationEvent("nav.feedback", command.corr_id, {
                distance_remaining_m: 3,
                estimated_time_remaining_s: 3,
            }),
        )).toBe(true);
        expect(goal?.latest_feedback?.distance_remaining_m).toBe(3);
    });

    it("cancels using the original goal ID and completes on cancelled result", async () => {
        const connection = connectDevice();
        const started = navigateTo(deviceId, "kitchen");
        const gotoCommand = decodeCommand(connection);
        handleAck(createAck(gotoCommand, { accepted: true }, heartSeq));
        const goal = await started;

        const cancelling = cancelNavigation(deviceId, goal.goal_id);
        const cancelCommand = decodeCommand(connection, 1);
        expect(cancelCommand.topic).toBe("nav.cancel");
        expect(cancelCommand.payload).toEqual({ goal_id: goal.goal_id });
        handleAck(createAck(cancelCommand, { accepted: true }, heartSeq));

        await expect(cancelling).resolves.toMatchObject({
            goal_id: goal.goal_id,
            status: "cancelling",
        });
        expect(handleNavigationResult(
            deviceId,
            navigationEvent("nav.result", gotoCommand.corr_id, {
                success: false,
                total_time_s: 1,
                final_pose: { x: 0, y: 0, yaw: 0 },
                reason: "cancelled",
            }),
        )).toBe(true);
        expect(activeNavigationGoals.has(`${deviceId}:${goal.goal_id}`)).toBe(false);
    });

    it("turns a battery refusal into a human-facing non-retryable error", async () => {
        const connection = connectDevice();
        const started = navigateTo(deviceId, "kitchen");
        const command = decodeCommand(connection);
        handleAck(createAck(command, {
            accepted: false,
            reason: "battery_below_return_margin",
            details: { battery_pct: 16 },
        }, heartSeq));

        let refusal: unknown;
        try {
            await started;
        } catch (error: unknown) {
            refusal = error;
        }
        expect(refusal).toBeInstanceOf(NavigationRefusalError);
        expect((refusal as NavigationRefusalError).userMessage)
            .toBe("I can't go there right now — my battery is at 16% and I need enough charge to reach the dock.");
        expect(activeNavigationGoals.size).toBe(0);
    });

    it("ignores events with a mismatched correlation ID", async () => {
        const connection = connectDevice();
        const started = navigateTo(deviceId, "kitchen");
        const command = decodeCommand(connection);
        handleAck(createAck(command, { accepted: true }, heartSeq));
        const goal = await started;

        expect(handleNavigationResult(
            deviceId,
            navigationEvent("nav.result", "wrong-correlation", {
                success: true,
                total_time_s: 1,
                final_pose: { x: 1, y: 2, yaw: 0 },
            }),
        )).toBe(false);
        expect(activeNavigationGoals.has(`${deviceId}:${goal.goal_id}`)).toBe(true);
    });

    it("reserves the device before the first navigation ACK arrives", async () => {
        const connection = connectDevice();
        const first = navigateTo(deviceId, "kitchen");
        await expect(navigateTo(deviceId, "hallway")).rejects.toThrow(/already active/);

        const firstCommand = decodeCommand(connection);
        handleAck(createAck(firstCommand, { accepted: true }, heartSeq));
        await first;
    });

    it("cancels the device's active goal when no goal ID is supplied", async () => {
        const connection = connectDevice();
        const started = navigateTo(deviceId, "kitchen");
        const gotoCommand = decodeCommand(connection);
        handleAck(createAck(gotoCommand, { accepted: true }, heartSeq));
        const goal = await started;

        const cancelling = cancelNavigation(deviceId);
        const cancelCommand = decodeCommand(connection, 1);
        expect(cancelCommand.payload).toEqual({ goal_id: goal.goal_id });
        handleAck(createAck(cancelCommand, { accepted: true }, heartSeq));

        await expect(cancelling).resolves.toMatchObject({ goal_id: goal.goal_id });
    });

    it("keeps an active goal when its device disconnects", async () => {
        const connection = connectDevice();
        const started = navigateTo(deviceId, "kitchen");
        const command = decodeCommand(connection);
        handleAck(createAck(command, { accepted: true }, heartSeq));
        const goal = await started;

        // The server no longer calls clearNavigationForDevice on close; a reconnect can deliver the result.
        expect(activeNavigationGoals.has(`${deviceId}:${goal.goal_id}`)).toBe(true);
    });

    it("drops a goal the Heart no longer knows so navigation is not locked out", async () => {
        const connection = connectDevice();
        const started = navigateTo(deviceId, "kitchen");
        handleAck(createAck(decodeCommand(connection), { accepted: true }, heartSeq));
        const goal = await started;

        const cancelling = cancelNavigation(deviceId);
        handleAck(createAck(decodeCommand(connection, 1), {
            accepted: false,
            reason: "goal_not_found",
        }, heartSeq));

        await expect(cancelling).rejects.toThrow(/goal_not_found/);
        expect(activeNavigationGoals.has(`${deviceId}:${goal.goal_id}`)).toBe(false);
    });
});
