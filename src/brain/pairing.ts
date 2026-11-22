import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { loadState, saveState } from "./state.ts";
import { ProtocolDefaults, type AckPayload } from "@miobots/protocol";

/**
 * Pairing a laptop daemon (G0.2, GANGLION_DECISIONS 29).
 *
 * The laptop shows a six-digit code, a human types it into the app, and Brain issues the daemon its
 * own token. Only the token's hash is kept. Finding a device on the network is never permission to
 * use it, so a daemon is admitted by its paired token and nothing else.
 */

export interface PairedGanglion {
  device_id: string;
  name: string;
  token_sha256: string;
  paired_at: string;
}

interface Pending {
  deviceId: string;
  name: string;
  timer: ReturnType<typeof setTimeout>;
  complete: (ack: AckPayload) => void;
}

/** Wrong codes in a row before every waiting laptop is turned away and must show a new code. */
export const MAX_WRONG_CODES = 5;

const pending = new Map<string, Pending>();
let wrongCodes = 0;

// A file, or `brain_state` in Postgres when there is a database (BRAIN_DECISIONS 30).
function load(): PairedGanglion[] {
  const parsed = loadState<unknown>("paired_ganglions");
  return Array.isArray(parsed) ? (parsed as PairedGanglion[]) : [];
}

function save(list: PairedGanglion[]): void {
  saveState("paired_ganglions", list);
}

const sha256 = (token: string): Buffer => createHash("sha256").update(token).digest();

/** What the app may see about each paired laptop: never its token hash. */
export function listPaired(): { device_id: string; name: string; paired_at: string }[] {
  return load().map(({ device_id, name, paired_at }) => ({ device_id, name, paired_at }));
}

export function isPaired(deviceId: string): boolean {
  return load().some((entry) => entry.device_id === deviceId);
}

export function isPairedToken(deviceId: string, token: string): boolean {
  const entry = load().find((candidate) => candidate.device_id === deviceId);
  if (!entry) return false;
  const stored = Buffer.from(entry.token_sha256, "hex");
  const offered = sha256(token);
  return stored.length === offered.length && timingSafeEqual(stored, offered);
}

/** Issues (or replaces) a device's token. Exported so tests can pre-pair a daemon. */
export function pairDevice(deviceId: string, name: string, token = randomBytes(32).toString("hex")): string {
  const list = load().filter((entry) => entry.device_id !== deviceId);
  list.push({ device_id: deviceId, name, token_sha256: sha256(token).toString("hex"), paired_at: new Date().toISOString() });
  save(list);
  return token;
}

/**
 * A laptop starts waiting with its code. Returns a refusal to send at once, or undefined when the
 * answer will arrive later through `complete` — on confirmation, expiry, or a lockout.
 */
export function requestPairing(
  code: string,
  request: { deviceId: string; name: string; complete: (ack: AckPayload) => void },
): AckPayload | undefined {
  if (pending.has(code)) return { accepted: false, reason: "That code is already waiting; show a new one." };
  const timer = setTimeout(() => finish(code, { accepted: false, reason: "expired" }), ProtocolDefaults.PAIRING_CODE_TTL_MS);
  timer.unref?.();
  pending.set(code, { ...request, timer });
  console.log(`[PAIRING] waiting device=${request.deviceId} name=${request.name}`);
  return undefined;
}

/** The laptop hung up before anyone typed its code. */
export function cancelPairing(code: string): void {
  const entry = pending.get(code);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(code);
}

/** A human typed a code into the app. */
export function confirmPairing(code: string): AckPayload {
  const entry = pending.get(code);
  if (!entry) {
    wrongCodes++;
    if (wrongCodes >= MAX_WRONG_CODES) {
      wrongCodes = 0;
      for (const waiting of [...pending.keys()]) {
        finish(waiting, { accepted: false, reason: "Too many wrong codes; pairing was reset. Show a new code." });
      }
      console.warn("[PAIRING] too many wrong codes, every waiting laptop was turned away");
      return { accepted: false, reason: "Too many wrong codes. Start pairing again on the laptop." };
    }
    return { accepted: false, reason: "No laptop is waiting with that code." };
  }
  wrongCodes = 0;
  const token = pairDevice(entry.deviceId, entry.name);
  finish(code, { accepted: true, token, name: entry.name });
  console.log(`[PAIRING] paired device=${entry.deviceId} name=${entry.name}`);
  return { accepted: true, name: entry.name };
}

function finish(code: string, ack: AckPayload): void {
  const entry = pending.get(code);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(code);
  entry.complete(ack);
}
