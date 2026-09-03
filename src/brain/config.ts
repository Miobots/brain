import "dotenv/config";

const port = Number(process.env.PORT) || 8080;
const devToken = process.env.DEV_TOKEN ?? "test-dev-token";
const timeout_ms = Number(process.env.ACK_TIMEOUT) || 5000;
const max_message_size = Number(process.env.MAX_MESSAGE_SIZE) || 5 * 1024 * 1024;
const idempotency_ttl_ms = Number(process.env.IDEMPOTENCY_TTL_MS) || 10 * 60 * 1000;
const idempotency_cleanup_interval_ms = Number(
    process.env.IDEMPOTENCY_CLEANUP_INTERVAL_MS
) || 60 * 1000;
const command_expiry_ms = Number(process.env.COMMAND_EXPIRY_MS) || 30 * 1000;

export const config = {
    port,
    devToken,
    timeout_ms,
    max_message_size,
    idempotency_ttl_ms,
    idempotency_cleanup_interval_ms,
    command_expiry_ms,
};