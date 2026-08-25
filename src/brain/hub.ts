import type { SpeakPayload } from "@miobots/protocol";
import {
    encode,
    Kind,
    newEnvelope,
    Topics,
} from "@miobots/protocol";
import type { Envelope } from "@miobots/protocol";
import { devices } from "./server.ts";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import {
    deviceCommands,
    CommandRecord,
} from "./command-store.ts";

type PendingCommand = {
    device_id: string;
    idem_key: string;
    resolve: (ack: Envelope<string, unknown>) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

const pendingCommands = new Map<string, PendingCommand>();

export function getExistingCommand(
    map: Map<string, CommandRecord>,
    idem_key: string,
): Promise<Envelope<string, unknown>> | undefined {

    const existing = map.get(idem_key);

    if (!existing) {
        return undefined;
    }
    if (Date.now() >= existing.expires_at) {
        existing.status = "expired";

        return Promise.reject(
            new Error(
                `[HUB] Command expired: idem_key=${idem_key}`
            )
        );
    }
    if (existing.status === "pending") {
        return existing.promise;
    }

    if (existing.status === "resolved") {
        if (!existing.ack) {
            return Promise.reject(
                new Error(
                    `[HUB] Command is marked resolved but has no ACK: idem_key=${idem_key}`
                )
            );
        }

        return Promise.resolve(existing.ack);
    }

    if (existing.status === "timeout") {
        return Promise.reject(
            new Error(
                `[HUB] Command previously timed out: idem_key=${idem_key}`
            )
        );
    }

    if (existing.status === "expired") {
        return Promise.reject(
            new Error(
                `[HUB] Command expired: idem_key=${idem_key}`
            )
        );
    }

    return undefined;
}

export function handleAck(
    ack: Envelope<string, unknown>,
): void {

    const corr_id = ack.corr_id;

    if (!corr_id) {
        console.log(`[HUB] IN ACK without corr_id`);
        return;
    }

    console.log(
        `[HUB] IN corr_id=${corr_id} kind=${ack.kind}`
    );

    const pending = pendingCommands.get(corr_id);

    if (!pending) {
        console.log(
            `[HUB] No pending command for corr_id=${corr_id}`
        );
        return;
    }

    const map = deviceCommands.get(pending.device_id);

    if (map) {
        const command = map.get(pending.idem_key);

        if (command) {
            command.status = "resolved";
            command.ack = ack;
        }
    }

    clearTimeout(pending.timeout);
    pendingCommands.delete(corr_id);

    pending.resolve(ack);
}

export function sendCommand(
    device_id: string,
    topic: typeof Topics.VOICE_SPEAK,
    payload: SpeakPayload,
    idem_key?: string,
): Promise<Envelope<string, unknown>> {

    const connection = devices.get(device_id);

    if (!connection) {
        return Promise.reject(
            new Error(
                `[HUB] Device ${device_id} is not connected`
            )
        );
    }

    const map = deviceCommands.get(device_id);

    if (map === undefined) {
        return Promise.reject(
            new Error(
                `[HUB] Map has not been initialised`
            )
        );
    }


    if (idem_key) {
        const existing = getExistingCommand(map, idem_key);

        if (existing) {
            return existing;
        }
    }


    const corr_id = randomUUID();
    const commandIdemKey = idem_key ?? randomUUID();
    const expires_at = Date.now() + config.command_expiry_ms;

    console.log(
        `[HUB] OUT corr_id=${corr_id} ` +
        `topic=${topic} ` +
        `idem_key=${commandIdemKey}`
    );

    const env = newEnvelope({
        corr_id,
        idem_key: commandIdemKey,
        kind: Kind.CMD,
        topic,
        payload,
        expires_at: expires_at,
    });


    const ackPromise = new Promise<Envelope<string, unknown>>(
        (resolve, reject) => {

            const timeout = setTimeout(() => {

                pendingCommands.delete(corr_id);

                const command = map.get(commandIdemKey);

                if (command) {
                    command.status = "timeout";
                }

                console.log(
                    `[HUB] TIMEOUT corr_id=${corr_id} topic=${topic}`
                );

                reject(
                    new Error(
                        `[HUB] Command timed out after ` +
                        `${config.timeout_ms}ms: corr_id=${corr_id}`
                    )
                );

            }, config.timeout_ms);
            pendingCommands.set(corr_id, {
                device_id,
                idem_key: commandIdemKey,
                resolve,
                reject,
                timeout,
            });
        }
    );


    const commandRecord: CommandRecord = {
        idem_key: commandIdemKey,
        corr_id,
        status: "pending",
        promise: ackPromise,
        createdAt: Date.now(),
        expires_at
    };

    map.set(commandIdemKey, commandRecord);


    connection.send(encode(env));

    return ackPromise;
}