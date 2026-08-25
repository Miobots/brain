import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
    Language,
    Topics,
    createAck,
    decode,
    type Envelope,
} from "@miobots/protocol";

process.env.PORT = "45872";
process.env.DEV_TOKEN = "test-dev-token";
process.env.MAX_MESSAGE_SIZE = "5242880";
process.env.ACK_TIMEOUT = "50";
process.env.IDEMPOTENCY_TTL_MS = "60000";
process.env.IDEMPOTENCY_CLEANUP_INTERVAL_MS = "60000";
process.env.COMMAND_EXPIRY_MS = "25";

let hubModule: typeof import("../../../src/brain/hub.ts");
let commandStoreModule: typeof import("../../../src/brain/command-store.ts");
let serverModule: typeof import("../../../src/brain/server.ts");

type MockConnection = {
    send: ReturnType<typeof vi.fn>;
};

const deviceId = "heart-test-01";
const payload = {
    text: "Assalam o alaikum",
    lang: Language.UR,
};

function createConnection(): MockConnection {
    return { send: vi.fn() };
}

function decodeSentCommand(connection: MockConnection): Envelope<string, unknown> {
    return decode(connection.send.mock.calls[0][0]);
}

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

beforeAll(async () => {
    commandStoreModule = await import("../../../src/brain/command-store.ts");
    serverModule = await import("../../../src/brain/server.ts");
    hubModule = await import("../../../src/brain/hub.ts");
});

afterEach(() => {
    serverModule.devices.clear();
    commandStoreModule.deviceCommands.clear();
});

function connectMockDevice(connection = createConnection()): MockConnection {
    serverModule.devices.set(deviceId, connection as never);
    commandStoreModule.deviceCommands.set(deviceId, new Map());
    return connection;
}

describe("Brain Hub command idempotency", () => {
    it("sends a fresh command and resolves it when the matching ACK arrives", async () => {
        const connection = connectMockDevice();
        const commandPromise = hubModule.sendCommand(deviceId, Topics.VOICE_SPEAK, payload);
        const command = decodeSentCommand(connection);

        expect(command.idem_key).toEqual(expect.any(String));
        expect(command.corr_id).toEqual(expect.any(String));
        expect(connection.send).toHaveBeenCalledTimes(1);

        const ack = createAck(command, { accepted: true });
        hubModule.handleAck(ack);

        await expect(commandPromise).resolves.toBe(ack);
        expect(commandStoreModule.deviceCommands.get(deviceId)?.get(command.idem_key!)?.status)
            .toBe("resolved");
    });

    it("reuses a pending command and sends it only once", async () => {
        const connection = connectMockDevice();
        const idemKey = "duplicate-pending";
        const first = hubModule.sendCommand(deviceId, Topics.VOICE_SPEAK, payload, idemKey);
        const second = hubModule.sendCommand(deviceId, Topics.VOICE_SPEAK, payload, idemKey);
        const command = decodeSentCommand(connection);

        expect(second).toBe(first);
        expect(connection.send).toHaveBeenCalledTimes(1);

        hubModule.handleAck(createAck(command, { accepted: true }));
        await expect(first).resolves.toMatchObject({ corr_id: command.corr_id });
        await expect(second).resolves.toMatchObject({ corr_id: command.corr_id });
    });

    it("returns the original ACK after a command has resolved", async () => {
        const connection = connectMockDevice();
        const idemKey = "duplicate-resolved";
        const first = hubModule.sendCommand(deviceId, Topics.VOICE_SPEAK, payload, idemKey);
        const command = decodeSentCommand(connection);
        const ack = createAck(command, { accepted: true });
        hubModule.handleAck(ack);
        await expect(first).resolves.toBe(ack);

        const second = hubModule.sendCommand(deviceId, Topics.VOICE_SPEAK, payload, idemKey);

        await expect(second).resolves.toBe(ack);
        expect(connection.send).toHaveBeenCalledTimes(1);
    });

    it("rejects an expired command without sending it again", async () => {
        const connection = connectMockDevice();
        const idemKey = "already-expired";
        const first = hubModule.sendCommand(deviceId, Topics.VOICE_SPEAK, payload, idemKey);
        const command = decodeSentCommand(connection);
        const record = commandStoreModule.deviceCommands.get(deviceId)!.get(idemKey)!;
        const firstRejection = expect(first).rejects.toThrow(/Command timed out/);

        expect(command.expires_at).toEqual(expect.any(Number));
        await wait(75);
        expect(command.expires_at).toBeLessThanOrEqual(Date.now());
        await firstRejection;

        await expect(
            hubModule.sendCommand(deviceId, Topics.VOICE_SPEAK, payload, idemKey),
        ).rejects.toThrow(`[HUB] Command expired: idem_key=${idemKey}`);
        expect(record.status).toBe("expired");
        expect(connection.send).toHaveBeenCalledTimes(1);
    });

    it("rejects a command after the ACK timeout and marks it as timed out", async () => {
        const connection = connectMockDevice();
        const promise = hubModule.sendCommand(deviceId, Topics.VOICE_SPEAK, payload, "timeout");

        await expect(promise).rejects.toThrow(/Command timed out after 50ms/);
        expect(commandStoreModule.deviceCommands.get(deviceId)?.get("timeout")?.status)
            .toBe("timeout");
        expect(connection.send).toHaveBeenCalledTimes(1);
    });

    it("rejects when the device is not connected", async () => {
        commandStoreModule.deviceCommands.set("missing-device", new Map());

        await expect(
            hubModule.sendCommand("missing-device", Topics.VOICE_SPEAK, payload),
        ).rejects.toThrow("[HUB] Device missing-device is not connected");
    });
});