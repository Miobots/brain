/**
 * Receipts for events (ENVELOPE.md §8). A dialer keeps every event in its outbox until the Brain
 * names it in an `ACK sys.receipt`, and sends whatever is still unconfirmed again after it
 * reconnects. So the same event can arrive twice — its receipt was lost with the link — and must
 * be confirmed both times but acted on once.
 */

const SEEN_LIMIT = 10_000;

// ponytail: in memory, so a Brain that restarts between acting on an event and its receipt
// reaching the robot acts on it again. Durable once events are stored in Postgres (B4.x).
const seen = new Set<string>();

/** True the first time an event's `msg_id` arrives; false for a re-sent copy. */
export function firstDelivery(msgId: string): boolean {
    if (seen.has(msgId)) return false;
    seen.add(msgId);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
    return true;
}

/** An event whose handling failed: the next copy the robot sends must be acted on, not skipped. */
export function forgetDelivery(msgId: string): void {
    seen.delete(msgId);
}
