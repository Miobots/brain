import type { WebSocket } from "ws";
import type { DeviceRole, SequenceCounter } from "@miobots/protocol";

// Connected Hearts by device_id. Kept out of server.ts so hub/tools/agent can import it
// without evaluating the server (and its listen() side effect).
export const devices = new Map<string, WebSocket>();

/** Roles recorded from the authenticated sys.hello handshake. */
export const deviceRoles = new Map<string, DeviceRole>();

/**
 * Resolves a connected physical robot using trusted handshake state.
 * Map insertion order is the deterministic tie-breaker when several Hearts are connected.
 */
export function resolveHeartDeviceId(requested?: string): string {
	if (requested !== undefined) {
		const deviceId = requested.trim();
		if (!deviceId || !devices.has(deviceId) || deviceRoles.get(deviceId) !== "heart") {
			throw new Error("Requested Heart device is not connected or authorized");
		}
		return deviceId;
	}

	for (const [deviceId, role] of deviceRoles) {
		if (role === "heart" && devices.has(deviceId)) return deviceId;
	}

	throw new Error("Heart device is not connected or authorized");
}

/**
 * One outbound sequence counter per connected device.
 *
 * ENVELOPE.md §6: "A process holding several connections keeps one counter per connection — a
 * single shared counter makes gap detection meaningless the moment Heart, Synapse and Ganglion
 * are attached at once." Kept alongside `devices` rather than inside it so the change does not
 * ripple through hub.ts, tools.ts and six test files for no behavioural gain.
 */
export const deviceSeq = new Map<string, SequenceCounter>();
