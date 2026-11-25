import pg from "pg";
import { randomUUID } from "node:crypto";
import { Topics, isSchedFiredPayload, type ScheduleOccurrence, type SchedWindowPayload, type AckPayload } from "@miobots/protocol";
import type { ToolDefinition } from "../ai/types.ts";
import { sendCommand } from "./hub.ts";
import { devices, deviceRoles } from "./devices.ts";

/**
 * Reminders (B4.1–B4.3). The Brain owns the rule; the robot only ever sees moments.
 *
 * A rule is expanded here into the concrete occurrences of the next 72 h and pushed down as one
 * `sched.window` that replaces whatever the robot held (ENVELOPE §5). The robot fires them on its
 * own clock — with or without us — and reports `sched.fired`, which is recorded once per
 * occurrence. "Heart owns the past, Brain owns the future": cancelling a reminder hides its future
 * occurrences and never touches a firing that already happened.
 */

export type Rule =
  | { kind: "once"; at_ms: number }
  | { kind: "daily" | "weekdays"; time: string }
  | { kind: "weekly"; time: string; days: number[] }; // days: 0 = Sunday … 6 = Saturday

export interface Reminder {
  id: string;
  text: string;
  rule: Rule;
  tz: string;
  deleted: boolean;
  version: number;
  updated_ms: number;
}

export interface Firing {
  occurrence_id: string;
  reminder_id: string;
  fired_ms: number;
}

export interface ReminderStore {
  all(): Promise<Reminder[]>;
  save(reminder: Reminder): Promise<void>;
  /** True if this occurrence had not been recorded before: a repeated report changes nothing. */
  recordFiring(firing: Firing): Promise<boolean>;
  firings(): Promise<Firing[]>;
}

export const WINDOW_MS = 72 * 60 * 60 * 1000;
/** The window rolls forward: re-sent hourly, so the robot always holds at least 71 h ahead. */
const REFRESH_MS = 60 * 60 * 1000;
export const HOUSEHOLD_TZ = process.env.HOUSEHOLD_TZ || "Asia/Karachi";

// ---------- time ----------

/** Milliseconds the zone is ahead of UTC at instant `ms`. */
function zoneOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time happens in `tz`. Checked twice so a DST change between guesses is honoured. */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let utc = wall - zoneOffsetMs(wall, tz);
  utc = wall - zoneOffsetMs(utc, tz);
  return utc;
}

/** The calendar date in `tz` at instant `ms`. */
export function zonedDate(ms: number, tz: string): { y: number; m: number; d: number } {
  const local = new Date(ms + zoneOffsetMs(ms, tz));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}

function parseTime(time: string): [number, number] {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!match) throw new Error(`time must be HH:MM (24 h), got "${time}"`);
  return [Number(match[1]), Number(match[2])];
}

/** "Wed 2026-11-25 14:05" in the household's zone — for the agent's situation block. */
export function localTimeLine(nowMs: number = Date.now(), tz: string = HOUSEHOLD_TZ): string {
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(nowMs));
  return `Local time: ${text} (${tz})`;
}

// ---------- expansion (B4.1) ----------

export function occurrenceId(reminderId: string, dueMs: number): string {
  return `${reminderId}@${dueMs}`;
}

/** Every occurrence of one reminder due in [fromMs, toMs), oldest first. */
export function expand(reminder: Reminder, fromMs: number, toMs: number): ScheduleOccurrence[] {
  if (reminder.deleted) return [];
  const due: number[] = [];
  const { rule, tz } = reminder;
  if (rule.kind === "once") {
    due.push(rule.at_ms);
  } else {
    const [hh, mm] = parseTime(rule.time);
    // Walk calendar days in the household's zone, from the day before `from` to the day after `to`.
    for (let t = fromMs - 86_400_000; t <= toMs + 86_400_000; t += 86_400_000) {
      const { y, m, d } = zonedDate(t, tz);
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      if (rule.kind === "weekdays" && (weekday === 0 || weekday === 6)) continue;
      if (rule.kind === "weekly" && !rule.days.includes(weekday)) continue;
      due.push(zonedToUtc(y, m, d, hh, mm, tz));
    }
  }
  return [...new Set(due)]
    .filter((ms) => ms >= fromMs && ms < toMs)
    .sort((a, b) => a - b)
    .map((ms) => ({ occurrence_id: occurrenceId(reminder.id, ms), reminder_id: reminder.id, text: reminder.text, due_time_ms: ms }));
}

// ---------- stores ----------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reminders (
  id          text    PRIMARY KEY,
  text        text    NOT NULL,
  rule        jsonb   NOT NULL,
  tz          text    NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_at  bigint  NOT NULL,
  deleted     boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS reminder_firings (
  occurrence_id text   PRIMARY KEY,
  reminder_id   text   NOT NULL,
  fired_at      bigint NOT NULL,
  learned_at    bigint NOT NULL
);`;

export function postgresReminderStore(connectionString: string): ReminderStore & { ready: Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 3 });
  const ready = pool.query(SCHEMA).then(() => undefined);
  const timed = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    // Neon sleeps when idle; a slow first query after a quiet spell is that, not a bug (B3.1).
    const start = performance.now();
    try { return await run(); } finally {
      const ms = performance.now() - start;
      if (ms > 500) console.log(`[REMINDERS] ${label} took ${ms.toFixed(0)} ms`);
    }
  };
  return {
    ready,
    async all() {
      await ready;
      const { rows } = await timed("all", () => pool.query("SELECT * FROM reminders"));
      return rows.map((r) => ({ id: r.id, text: r.text, rule: r.rule, tz: r.tz, deleted: r.deleted, version: r.version, updated_ms: Number(r.updated_at) }));
    },
    async save(r) {
      await ready;
      await timed("save", () => pool.query(
        `INSERT INTO reminders (id, text, rule, tz, version, updated_at, deleted) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET text=$2, rule=$3, tz=$4, version=$5, updated_at=$6, deleted=$7`,
        [r.id, r.text, JSON.stringify(r.rule), r.tz, r.version, r.updated_ms, r.deleted],
      ));
    },
    async recordFiring(f) {
      await ready;
      const { rowCount } = await timed("recordFiring", () => pool.query(
        `INSERT INTO reminder_firings (occurrence_id, reminder_id, fired_at, learned_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (occurrence_id) DO NOTHING`,
        [f.occurrence_id, f.reminder_id, f.fired_ms, Date.now()],
      ));
      return rowCount === 1;
    },
    async firings() {
      await ready;
      const { rows } = await timed("firings", () => pool.query("SELECT * FROM reminder_firings ORDER BY fired_at"));
      return rows.map((r) => ({ occurrence_id: r.occurrence_id, reminder_id: r.reminder_id, fired_ms: Number(r.fired_at) }));
    },
  };
}

export function memoryReminderStore(): ReminderStore {
  const reminders = new Map<string, Reminder>();
  const fired = new Map<string, Firing>();
  return {
    async all() { return [...reminders.values()].map((r) => ({ ...r })); },
    async save(r) { reminders.set(r.id, { ...r }); },
    async recordFiring(f) {
      if (fired.has(f.occurrence_id)) return false;
      fired.set(f.occurrence_id, f);
      return true;
    },
    async firings() { return [...fired.values()].sort((a, b) => a.fired_ms - b.fired_ms); },
  };
}

let store: ReminderStore = memoryReminderStore();
let refresh: ReturnType<typeof setInterval> | undefined;

export async function initReminders(next: ReminderStore | undefined): Promise<void> {
  if (!next) {
    // ponytail: in memory without DATABASE_URL, so reminders vanish with a Brain restart. The robot
    // still fires what it was sent; only creating and history need the database.
    console.warn("[REMINDERS] DATABASE_URL is not set: reminders are kept in memory and lost on restart.");
  }
  store = next ?? memoryReminderStore();
  if ("ready" in store) await (store as { ready: Promise<void> }).ready;
  if (!refresh) {
    refresh = setInterval(() => void pushWindowToHearts(), REFRESH_MS);
    refresh.unref?.();
  }
}

// ---------- window (B4.2) ----------

export async function windowFor(nowMs: number = Date.now()): Promise<SchedWindowPayload> {
  const firedIds = new Set((await store.firings()).map((f) => f.occurrence_id));
  const occurrences = (await store.all())
    .flatMap((r) => expand(r, nowMs, nowMs + WINDOW_MS))
    .filter((o) => !firedIds.has(o.occurrence_id))
    .sort((a, b) => a.due_time_ms - b.due_time_ms);
  return { occurrences };
}

/** The whole window to one Heart — on connect, on every change, and hourly so it keeps rolling. */
export async function pushWindow(deviceId: string): Promise<void> {
  try {
    const window = await windowFor();
    const ack = await sendCommand(deviceId, Topics.SCHED_WINDOW, window);
    const accepted = (ack.payload as Partial<AckPayload> | undefined)?.accepted !== false;
    console.log(`[REMINDERS] window of ${window.occurrences.length} occurrence(s) to ${deviceId}: ${accepted ? "accepted" : "refused"}`);
  } catch (error) {
    // The robot keeps the last window it accepted; the next connect or change sends a fresh one.
    console.log(`[REMINDERS] window to ${deviceId} not delivered: ${error instanceof Error ? error.message : error}`);
  }
}

export async function pushWindowToHearts(): Promise<void> {
  const hearts = [...deviceRoles].filter(([id, role]) => role === "heart" && devices.has(id)).map(([id]) => id);
  await Promise.all(hearts.map(pushWindow));
}

// ---------- firings (B4.3) ----------

/**
 * `sched.fired` from a robot. Recorded once per occurrence, however many times it is reported;
 * the firing stands even if the reminder has since been cancelled. Resolves false only when it
 * could not be stored — then the caller must not confirm it, so the robot sends it again.
 */
export async function recordFired(deviceId: string, payload: unknown, firedMs: number): Promise<boolean> {
  if (!isSchedFiredPayload(payload)) {
    console.log(`[REMINDERS] invalid sched.fired from ${deviceId}`);
    return true; // malformed will never become valid: confirm it so it stops coming back
  }
  const reminderId = payload.occurrence_id.split("@")[0]!;
  try {
    const fresh = await store.recordFiring({ occurrence_id: payload.occurrence_id, reminder_id: reminderId, fired_ms: firedMs });
    const reminder = (await store.all()).find((r) => r.id === reminderId);
    console.log(`[REMINDERS] ${fresh ? "fired" : "already recorded"} ${payload.occurrence_id} "${reminder?.text ?? "?"}" at ${new Date(firedMs).toISOString()} on ${deviceId}`);
    return true;
  } catch (error) {
    console.log(`[REMINDERS] could not record ${payload.occurrence_id}: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

// ---------- create / cancel ----------

export async function createReminder(text: string, rule: Rule, nowMs: number = Date.now()): Promise<Reminder> {
  const reminder: Reminder = { id: `rem-${randomUUID().slice(0, 8)}`, text, rule, tz: HOUSEHOLD_TZ, deleted: false, version: 1, updated_ms: nowMs };
  await store.save(reminder);
  void pushWindowToHearts();
  return reminder;
}

/** Future occurrences only: what the robot already announced stays announced. */
export async function cancelReminder(id: string, nowMs: number = Date.now()): Promise<Reminder | undefined> {
  const reminder = (await store.all()).find((r) => r.id === id && !r.deleted);
  if (!reminder) return undefined;
  const cancelled = { ...reminder, deleted: true, version: reminder.version + 1, updated_ms: nowMs };
  await store.save(cancelled);
  void pushWindowToHearts();
  return cancelled;
}

export async function listReminders(): Promise<Reminder[]> {
  return (await store.all()).filter((r) => !r.deleted);
}

export async function reminderFirings(): Promise<Firing[]> {
  return store.firings();
}

// ---------- tools ----------

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Turns the tool's arguments into a rule. Exported for tests. */
export function ruleFromArgs(args: Record<string, unknown>, nowMs: number = Date.now(), tz: string = HOUSEHOLD_TZ): Rule {
  const repeat = typeof args.repeat === "string" ? args.repeat : "none";
  if (typeof args.in_minutes === "number" && args.in_minutes > 0) {
    if (repeat !== "none") throw new Error("in_minutes is for one-off reminders; give a time for repeating ones");
    return { kind: "once", at_ms: nowMs + Math.round(args.in_minutes * 60_000) };
  }
  if (typeof args.time !== "string") throw new Error("Give either time (HH:MM) or in_minutes");
  const [hh, mm] = parseTime(args.time);
  if (repeat === "daily" || repeat === "weekdays") return { kind: repeat, time: args.time };
  if (repeat === "weekly") {
    const days = (Array.isArray(args.days) ? args.days : [])
      .map((d) => DAY_NAMES.indexOf(String(d).slice(0, 3).toLowerCase()))
      .filter((d) => d >= 0);
    if (days.length === 0) throw new Error("weekly reminders need days, e.g. [\"mon\", \"thu\"]");
    return { kind: "weekly", time: args.time, days };
  }
  // One-off: the given date, or the next time the clock shows this time.
  let { y, m, d } = zonedDate(nowMs, tz);
  if (typeof args.date === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.date.trim());
    if (!match) throw new Error(`date must be YYYY-MM-DD, got "${args.date}"`);
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  let at = zonedToUtc(y, m, d, hh, mm, tz);
  if (typeof args.date !== "string" && at <= nowMs) {
    ({ y, m, d } = zonedDate(nowMs + 86_400_000, tz));
    at = zonedToUtc(y, m, d, hh, mm, tz);
  }
  if (at <= nowMs) throw new Error("That time has already passed");
  return { kind: "once", at_ms: at };
}

function describe(r: Reminder): Record<string, unknown> {
  const next = expand(r, Date.now(), Date.now() + 365 * 86_400_000)[0];
  return {
    reminder_id: r.id,
    text: r.text,
    repeat: r.rule.kind === "once" ? "none" : r.rule.kind,
    next: next ? localTimeLine(next.due_time_ms, r.tz).replace("Local time: ", "") : "none",
  };
}

export const setReminderTool: ToolDefinition = {
  name: "set_reminder",
  description:
    "Create a reminder the robot will say aloud at the time, even if the internet is down. " +
    "Times are the household's local time (see Local time). Use in_minutes for 'in N minutes'.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "What to remind, phrased to be read aloud, e.g. 'take your medicine'." },
      time: { type: "string", description: "Local time, 24-hour HH:MM." },
      date: { type: "string", description: "Optional local date YYYY-MM-DD for a one-off. Omit for the next time the clock shows `time`." },
      in_minutes: { type: "number", description: "Alternative to time: minutes from now, for one-off reminders." },
      repeat: { type: "string", enum: ["none", "daily", "weekdays", "weekly"], description: "Defaults to none." },
      days: { type: "array", items: { type: "string" }, description: "For weekly: days like [\"mon\", \"thu\"]." },
    },
    required: ["text"],
  },
  execute: async (args: Record<string, unknown>) => {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) throw new Error("Missing or empty 'text' for set_reminder");
    const reminder = await createReminder(text, ruleFromArgs(args));
    return { status: "set", ...describe(reminder) };
  },
};

export const listRemindersTool: ToolDefinition = {
  name: "list_reminders",
  description: "List the active reminders with their IDs and next time.",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ reminders: (await listReminders()).map(describe) }),
};

export const cancelReminderTool: ToolDefinition = {
  name: "cancel_reminder",
  description: "Cancel a reminder by the reminder_id from list_reminders. Past announcements stay in history.",
  parameters: {
    type: "object",
    properties: { reminder_id: { type: "string", description: "The reminder_id to cancel." } },
    required: ["reminder_id"],
  },
  execute: async (args: Record<string, unknown>) => {
    const id = typeof args.reminder_id === "string" ? args.reminder_id.trim() : "";
    const cancelled = await cancelReminder(id);
    if (!cancelled) throw new Error(`No active reminder with id "${id}"`);
    return { status: "cancelled", reminder_id: id, text: cancelled.text };
  },
};
