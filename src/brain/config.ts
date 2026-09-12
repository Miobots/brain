import "dotenv/config";
import { ProtocolDefaults } from "@miobots/protocol";

/**
 * Lazily-read configuration.
 *
 * Getters rather than constants so a test can override a value after the module has been
 * imported — the hub and server are module singletons, so reading eagerly froze whatever the
 * environment happened to say at import time.
 *
 * Every wire-level limit falls back to ProtocolDefaults, never to a local literal. A second copy
 * of a protocol constant is a second thing to keep right: the Brain used to cap messages at 5 MB
 * while the codec capped them at 64 KB, so anything in between passed here and died in parse().
 */

let _port: number | undefined;
let _host: string | undefined;
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
    /**
     * Loopback by default. CLAUDE.md: "the token, not the network path, is the security boundary"
     * — and /dev/speak carries no token, so it must not be reachable from the LAN unless someone
     * decides that on purpose.
     */
    get host(): string {
        return _host ?? (process.env.HOST ?? "127.0.0.1");
    },
    set host(val: string) {
        _host = val;
    },
    get devToken(): string {
        return _devToken ?? (process.env.DEV_TOKEN ?? ProtocolDefaults.DEFAULT_DEV_TOKEN);
    },
    set devToken(val: string) {
        _devToken = val;
    },
    get timeout_ms(): number {
        return _timeout_ms ?? (Number(process.env.ACK_TIMEOUT) || ProtocolDefaults.DEFAULT_COMMAND_TIMEOUT_MS);
    },
    set timeout_ms(val: number) {
        _timeout_ms = val;
    },
    get max_message_size(): number {
        return _max_message_size ?? (Number(process.env.MAX_MESSAGE_SIZE) || ProtocolDefaults.MAX_MESSAGE_BYTES);
    },
    set max_message_size(val: number) {
        _max_message_size = val;
    },
    get idempotency_ttl_ms(): number {
        return _idempotency_ttl_ms ?? (Number(process.env.IDEMPOTENCY_TTL_MS) || ProtocolDefaults.IDEMPOTENCY_TTL_MS);
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
