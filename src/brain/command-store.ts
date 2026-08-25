import type { Envelope } from "@miobots/protocol";
import { config } from "./config.ts";

export type CommandStatus =
    | "pending"
    | "resolved"
    | "timeout"
    | "expired";

export type CommandRecord = {
    idem_key: string;
    corr_id: string;
    status: CommandStatus;
    ack?: Envelope<string, unknown>;
    timeout?: ReturnType<typeof setTimeout>;
    promise: Promise<Envelope<string, unknown>>;
    createdAt: number;
    expires_at: number;
};
export const deviceCommands =
    new Map<string, Map<string, CommandRecord>>();

export function cleanupExpiredCommands(): void {
    const now = Date.now();

    for (const [deviceId, commands] of deviceCommands) {
        for (const [idemKey, command] of commands) {
            const age = now - command.createdAt;

            if (age >= config.idempotency_ttl_ms) {
                commands.delete(idemKey);

                console.log(
                    `[COMMAND STORE] Removed command ` +
                    `device=${deviceId} ` +
                    `idem_key=${idemKey}`
                );
            }
        }

        if (commands.size === 0) {
            deviceCommands.delete(deviceId);
        }
    }
}

setInterval(
    cleanupExpiredCommands,
    config.idempotency_cleanup_interval_ms
);