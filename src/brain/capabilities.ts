import {
    BrainCapabilities,
    DeviceRole,
    type CapabilityManifestPayload,
} from "@miobots/protocol";

/**
 * The Brain's half of `cap.manifest` (TASKS.md S1.2) — the cloud side the robot cannot vouch for.
 *
 * Only what is true today: a capability with no code behind it says so, rather than claiming to
 * work and failing when tapped. Update a line here when its feature lands.
 */
export function brainManifest(connectedRoles: Iterable<DeviceRole>): CapabilityManifestPayload {
    const laptopConnected = [...connectedRoles].includes(DeviceRole.GANGLION);

    return {
        capabilities: {
            [BrainCapabilities.LAPTOP_DAEMON]: laptopConnected
                ? { state: "available" }
                : { state: "unavailable", reason: "The laptop daemon isn't running." },
            [BrainCapabilities.SMART_HOME]: { state: "unavailable", reason: "Smart home isn't set up yet." },
            [BrainCapabilities.MEMORY]: { state: "unavailable", reason: "Memory isn't built yet." },
        },
    };
}
