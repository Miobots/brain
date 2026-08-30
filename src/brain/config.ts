import "dotenv/config";

const port = Number(process.env.PORT);
const max_message_size = Number(process.env.MAX_MESSAGE_SIZE);
const devToken = process.env.DEV_TOKEN;
const timeout_ms = Number(process.env.ACK_TIMEOUT);
const idempotency_ttl_ms = Number(process.env.IDEMPOTENCY_TTL_MS);
const idempotency_cleanup_interval_ms = Number(
    process.env.IDEMPOTENCY_CLEANUP_INTERVAL_MS
);
const command_expiry_ms = Number(process.env.COMMAND_EXPIRY_MS);

if (!port) {
    throw new Error("[CONFIG] PORT is not set");
}


if (!command_expiry_ms) {
    throw new Error("[CONFIG] COMMAND_EXPIRY_MS is not set");
}
if (!max_message_size) {
    throw new Error("[CONFIG] MAX_MESSAGE_SIZE is not set!");
}

if (!devToken) {
    throw new Error(
        "[CONFIG] DEV_TOKEN not present, refusing to start..."
    );
}

if (!timeout_ms) {
    throw new Error("[CONFIG] ACK_TIMEOUT is not set");
}

if (!idempotency_ttl_ms) {
    throw new Error("[CONFIG] IDEMPOTENCY_TTL_MS is not set");
}

if (!idempotency_cleanup_interval_ms) {
    throw new Error(
        "[CONFIG] IDEMPOTENCY_CLEANUP_INTERVAL_MS is not set"
    );
}

if (!timeout_ms){
    throw new Error("Timeout not set")
}

export const config = {
    port,
    devToken,
    timeout_ms,
    max_message_size,
    idempotency_ttl_ms,
    idempotency_cleanup_interval_ms,
    command_expiry_ms,
};