import "dotenv/config";
import { ProtocolDefaults } from "@miobots/protocol";

let _port: number | undefined;
let _devToken: string | undefined;
let _timeout_ms: number | undefined;
let _max_message_size: number | undefined;
let _idempotency_ttl_ms: number | undefined;
let _idempotency_cleanup_interval_ms: number | undefined;
let _command_expiry_ms: number | undefined;

export const config = {
    get port(): number {
        return _port ?? (Number(process.env.PORT) || ProtocolDefaults.DEFAULT_PORT);
    },
    set port(val: number) {
        _port = val;
    },
    get devToken(): string {
        return _devToken ?? (process.env.DEV_TOKEN ?? ProtocolDefaults.DEFAULT_DEV_TOKEN);
    },
    set devToken(val: string) {
        _devToken = val;
    },
    get timeout_ms(): number {
        return _timeout_ms ?? (Number(process.env.ACK_TIMEOUT) || 5000);
    },
    set timeout_ms(val: number) {
        _timeout_ms = val;
    },
    get max_message_size(): number {
        return _max_message_size ?? (Number(process.env.MAX_MESSAGE_SIZE) || 5 * 1024 * 1024);
    },
    set max_message_size(val: number) {
        _max_message_size = val;
    },
    get idempotency_ttl_ms(): number {
        return _idempotency_ttl_ms ?? (Number(process.env.IDEMPOTENCY_TTL_MS) || 10 * 60 * 1000);
    },
    set idempotency_ttl_ms(val: number) {
        _idempotency_ttl_ms = val;
    },
    get idempotency_cleanup_interval_ms(): number {
        return _idempotency_cleanup_interval_ms ?? (Number(process.env.IDEMPOTENCY_CLEANUP_INTERVAL_MS) || 60 * 1000);
    },
    set idempotency_cleanup_interval_ms(val: number) {
        _idempotency_cleanup_interval_ms = val;
    },
    get command_expiry_ms(): number {
        return _command_expiry_ms ?? (Number(process.env.COMMAND_EXPIRY_MS) || 30 * 1000);
    },
    set command_expiry_ms(val: number) {
        _command_expiry_ms = val;
    },
};