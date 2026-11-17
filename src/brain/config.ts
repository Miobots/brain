import "dotenv/config";
import { ProtocolDefaults } from "@miobots/protocol";

let _port: number | undefined;
let _host: string | undefined;
let _devToken: string | undefined;
let _timeout_ms: number | undefined;
let _max_message_size: number | undefined;
let _idempotency_ttl_ms: number | undefined;
let _idempotency_cleanup_interval_ms: number | undefined;
let _command_expiry_ms: number | undefined;
let _mcp_request_timeout_ms: number | undefined;
let _mcp_max_pending_requests: number | undefined;
let _mcp_rate_limit_per_second: number | undefined;
let _mcp_outbound_high_water_mark: number | undefined;

export const config = {
    get port(): number {
        return _port ?? (Number(process.env.PORT) || ProtocolDefaults.DEFAULT_PORT);
    },
    set port(val: number) {
        _port = val;
    },
    // Loopback by default. CLAUDE.md: "the token, not the network path, is the security boundary" —
    // and /dev/speak carries no token, so it must not be reachable from the LAN without someone
    // deciding that on purpose.
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
        return _timeout_ms ?? (Number(process.env.ACK_TIMEOUT) || 5000);
    },
    set timeout_ms(val: number) {
        _timeout_ms = val;
    },
    // Derived, not re-declared. A local 5 MB cap against the protocol's own 64 KB meant anything in
    // between passed the Brain's check and then died inside parse() — two limits for one rule.
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
    get mcpAllowedGanglionDeviceIds(): string[] {
        return (process.env.MCP_ALLOWED_GANGLION_DEVICE_IDS ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
    },
    get mcp_request_timeout_ms(): number {
        return _mcp_request_timeout_ms ?? (Number(process.env.MCP_REQUEST_TIMEOUT_MS) || 15_000);
    },
    set mcp_request_timeout_ms(val: number) {
        _mcp_request_timeout_ms = val;
    },
    get mcp_max_pending_requests(): number {
        return _mcp_max_pending_requests ?? (Number(process.env.MCP_MAX_PENDING_REQUESTS) || 16);
    },
    set mcp_max_pending_requests(val: number) {
        _mcp_max_pending_requests = val;
    },
    get mcp_rate_limit_per_second(): number {
        return _mcp_rate_limit_per_second ?? (Number(process.env.MCP_RATE_LIMIT_PER_SECOND) || 32);
    },
    set mcp_rate_limit_per_second(val: number) {
        _mcp_rate_limit_per_second = val;
    },
    get mcp_outbound_high_water_mark(): number {
        return _mcp_outbound_high_water_mark ?? (Number(process.env.MCP_OUTBOUND_HIGH_WATER_MARK) || 512 * 1024);
    },
    set mcp_outbound_high_water_mark(val: number) {
        _mcp_outbound_high_water_mark = val;
    },
};