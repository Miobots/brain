import {
    encode,
    Kind,
    newEnvelope,
    type Envelope,
} from "@miobots/protocol";
import { devices } from "./server.ts";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";

type PendingCommand = {
    resolve: (ack: Envelope<string, unknown>) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

const pendingCommands = new Map<string, PendingCommand>();

export function handleAck(ack: Envelope<string, unknown>): void {
    const corr_id = ack.corr_id;

    if (!corr_id) {
        console.log(`[HUB] IN ACK without corr_id`);
        return;
    }

    console.log(`[HUB] IN corr_id=${corr_id} kind=${ack.kind}`);

    const pending = pendingCommands.get(corr_id);

    if (!pending) {
        console.log(`[HUB] No pending command for corr_id=${corr_id}`);
        return;
    }

    clearTimeout(pending.timeout);
    pendingCommands.delete(corr_id);

    pending.resolve(ack);
}

export function sendCommand<T extends string = string, P = unknown>(
    device_id: string,
    topic: T,
    payload: P,
): Promise<Envelope<string, unknown>> {
    const connection = devices.get(device_id);

    if (!connection) {
        return Promise.reject(
            new Error(`[HUB] Device ${device_id} is not connected`)
        );
    }

    const corr_id = randomUUID();
    const idem_key = randomUUID();

    console.log(
        `[HUB] OUT corr_id=${corr_id} topic=${topic} idem_key=${idem_key}`
    );

    const env = newEnvelope({
        corr_id,
        idem_key,
        kind: Kind.CMD,
        topic,
        payload,
    });

    const ackPromise = new Promise<Envelope<string, unknown>>(
        (resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingCommands.delete(corr_id);

                console.log(
                    `[HUB] TIMEOUT corr_id=${corr_id} topic=${topic}`
                );

                reject(
                    new Error(
                        `[HUB] Command timed out after ${config.timeout_ms}ms: corr_id=${corr_id}`
                    )
                );
            }, config.timeout_ms);

            pendingCommands.set(corr_id, {
                resolve,
                reject,
                timeout,
            });
        }
    );

    connection.send(encode(env));

    return ackPromise;
}