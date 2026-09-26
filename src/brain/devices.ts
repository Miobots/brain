import type { WebSocket } from "ws";
import type { SequenceCounter } from "@miobots/protocol";

// Connected Hearts by device_id. Kept out of server.ts so hub/tools/agent can import it
// without evaluating the server (and its listen() side effect).
export const devices = new Map<string, WebSocket>();

/**
 * One outbound sequence counter per connected device.
 *
 * ENVELOPE.md §6: "A process holding several connections keeps one counter per connection — a
 * single shared counter makes gap detection meaningless the moment Heart, Synapse and Ganglion
 * are attached at once." Kept alongside `devices` rather than inside it so the change does not
 * ripple through hub.ts, tools.ts and six test files for no behavioural gain.
 */
export const deviceSeq = new Map<string, SequenceCounter>();
