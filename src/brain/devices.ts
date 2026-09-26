import type { WebSocket } from "ws";

// Connected Hearts by device_id. Kept out of server.ts so hub/tools/agent can import it
// without evaluating the server (and its listen() side effect).
export const devices = new Map<string, WebSocket>();
