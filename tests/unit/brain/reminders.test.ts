import { beforeEach, describe, expect, it } from "vitest";
import {
  WINDOW_MS, cancelReminder, createReminder, expand, initReminders, memoryReminderStore, recordFired,
  reminderFirings, ruleFromArgs, windowFor, zonedToUtc, type Reminder,
} from "../../../src/brain/reminders.ts";

// Wed 2026-11-25 10:00 in Karachi (UTC+5, no DST) = 05:00 UTC.
const NOW = Date.UTC(2026, 10, 25, 5, 0);
const reminder = (rule: Reminder["rule"], tz = "Asia/Karachi"): Reminder =>
  ({ id: "rem-1", text: "take your medicine", rule, tz, deleted: false, version: 1, updated_ms: NOW });

describe("expanding a rule into moments (B4.1)", () => {
  it("a daily reminder makes three concrete occurrences in the next 72 h", () => {
    const due = expand(reminder({ kind: "daily", time: "21:00" }), NOW, NOW + WINDOW_MS);
    expect(due.map((o) => new Date(o.due_time_ms).toISOString())).toEqual([
      "2026-11-25T16:00:00.000Z", "2026-11-26T16:00:00.000Z", "2026-11-27T16:00:00.000Z",
    ]);
    expect(due[0]!.occurrence_id).toBe(`rem-1@${due[0]!.due_time_ms}`);
  });

  it("weekdays skip Saturday and Sunday", () => {
    // Fri 2026-11-27 08:00 local onwards: Fri, then Mon — the weekend is skipped.
    const from = Date.UTC(2026, 10, 27, 2, 0);
    const due = expand(reminder({ kind: "weekdays", time: "08:00" }), from, from + 4 * 86_400_000);
    expect(due.map((o) => new Date(o.due_time_ms).getUTCDay())).toEqual([5, 1]);
  });

  it("a cancelled reminder has no future", () => {
    expect(expand({ ...reminder({ kind: "daily", time: "21:00" }), deleted: true }, NOW, NOW + WINDOW_MS)).toEqual([]);
  });

  it("wall-clock times survive a daylight-saving change", () => {
    // New York leaves DST on 2026-11-01: 08:00 is 12:00 UTC before and 13:00 UTC after.
    expect(new Date(zonedToUtc(2026, 10, 31, 8, 0, "America/New_York")).toISOString()).toBe("2026-10-31T12:00:00.000Z");
    expect(new Date(zonedToUtc(2026, 11, 2, 8, 0, "America/New_York")).toISOString()).toBe("2026-11-02T13:00:00.000Z");
  });
});

describe("turning tool arguments into a rule", () => {
  it("a time already past today means tomorrow", () => {
    const rule = ruleFromArgs({ time: "09:00" }, NOW, "Asia/Karachi");
    expect(rule).toEqual({ kind: "once", at_ms: Date.UTC(2026, 10, 26, 4, 0) });
  });
  it("in_minutes counts from now", () => {
    expect(ruleFromArgs({ in_minutes: 2 }, NOW)).toEqual({ kind: "once", at_ms: NOW + 120_000 });
  });
  it("weekly needs days", () => {
    expect(() => ruleFromArgs({ time: "09:00", repeat: "weekly" }, NOW)).toThrow();
    expect(ruleFromArgs({ time: "09:00", repeat: "weekly", days: ["Mon", "thursday"] }, NOW))
      .toEqual({ kind: "weekly", time: "09:00", days: [1, 4] });
  });
});

describe("the robot owns the past (B4.3, R7)", () => {
  beforeEach(async () => { await initReminders(memoryReminderStore()); });

  it("a firing reported twice is recorded once, and leaves the window", async () => {
    const r = await createReminder("drink water", { kind: "once", at_ms: Date.now() + 60_000 });
    const [occurrence] = (await windowFor()).occurrences;
    expect(occurrence!.reminder_id).toBe(r.id);

    expect(await recordFired("heart-01", { occurrence_id: occurrence!.occurrence_id }, Date.now())).toBe(true);
    expect(await recordFired("heart-01", { occurrence_id: occurrence!.occurrence_id }, Date.now())).toBe(true);
    expect(await reminderFirings()).toHaveLength(1);
    expect((await windowFor()).occurrences).toEqual([]);
  });

  it("cancelling after it fired keeps the firing and drops only the future", async () => {
    const r = await createReminder("medicine", { kind: "daily", time: "21:00" });
    const [first] = (await windowFor()).occurrences;
    await recordFired("heart-01", { occurrence_id: first!.occurrence_id }, Date.now());

    await cancelReminder(r.id);
    expect((await windowFor()).occurrences).toEqual([]);
    expect((await reminderFirings()).map((f) => f.occurrence_id)).toEqual([first!.occurrence_id]);
  });

  it("a malformed report is confirmed and ignored", async () => {
    expect(await recordFired("heart-01", { nope: true }, Date.now())).toBe(true);
    expect(await reminderFirings()).toEqual([]);
  });
});
