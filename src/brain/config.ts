import "dotenv/config";
import { ProtocolDefaults } from "@miobots/protocol";

const port = Number(process.env.PORT) || ProtocolDefaults.DEFAULT_PORT;
const devToken = process.env.DEV_TOKEN ?? ProtocolDefaults.DEFAULT_DEV_TOKEN;

// Loopback by default. CLAUDE.md: "the token, not the network path, is the security boundary" —
// and /dev/speak carries no token, so it must not be reachable from the LAN without someone
// deciding that on purpose.
const host = process.env.HOST ?? "127.0.0.1";

const timeout_ms = Number(process.env.ACK_TIMEOUT) || 5000;
// Derived, not re-declared. A local 5 MB cap against the protocol's own 64 KB meant anything in
// between passed the Brain's check and then died inside parse() — two limits for one rule.
const max_message_size =
    Number(process.env.MAX_MESSAGE_SIZE) || ProtocolDefaults.MAX_MESSAGE_BYTES;
const idempotency_ttl_ms =
    Number(process.env.IDEMPOTENCY_TTL_MS) || ProtocolDefaults.IDEMPOTENCY_TTL_MS;
const idempotency_cleanup_interval_ms = Number(
    process.env.IDEMPOTENCY_CLEANUP_INTERVAL_MS
) || 60 * 1000;
const command_expiry_ms = Number(process.env.COMMAND_EXPIRY_MS) || 30 * 1000;

export const config = {
    port,
    host,
    devToken,
    timeout_ms,
    max_message_size,
    idempotency_ttl_ms,
    idempotency_cleanup_interval_ms,
    command_expiry_ms,
};