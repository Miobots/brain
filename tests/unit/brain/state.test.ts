import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { flushState, initState, loadState, saveState } from "../../../src/brain/state.ts";

/** Just enough of pg.Pool for brain_state: one table, upserts, a select. */
function fakePool() {
  const rows = new Map<string, unknown>();
  const queries: string[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      if (sql.startsWith("SELECT")) return { rows: [...rows].map(([key, value]) => ({ key, value })) };
      if (sql.startsWith("INSERT")) rows.set(params[0] as string, JSON.parse(params[1] as string));
      return { rows: [] };
    },
  };
  return { rows, queries, pool: pool as unknown as pg.Pool };
}

afterEach(async () => {
  await initState(undefined);
});

describe("Brain state (BRAIN_DECISIONS 30)", () => {
  it("uses a file when there is no database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-state-"));
    process.env.APPROVAL_INBOX_FILE = join(dir, "inbox.json");
    await initState(undefined);
    saveState("approval_inbox", [{ approvalId: "a" }]);
    expect(loadState("approval_inbox")).toEqual([{ approvalId: "a" }]);
  });

  it("imports an old file once, then reads and writes the database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-state-"));
    process.env.PAIRED_GANGLIONS_FILE = join(dir, "paired.json");
    writeFileSync(process.env.PAIRED_GANGLIONS_FILE, JSON.stringify([{ device_id: "old-laptop" }]));
    const db = fakePool();
    await initState(db.pool);
    expect(db.rows.get("paired_ganglions")).toEqual([{ device_id: "old-laptop" }]);

    saveState("paired_ganglions", [{ device_id: "new-laptop" }]);
    expect(loadState("paired_ganglions")).toEqual([{ device_id: "new-laptop" }]);
    await flushState();
    expect(db.rows.get("paired_ganglions")).toEqual([{ device_id: "new-laptop" }]);

    // A restart reads the database, not the stale file.
    await initState(db.pool);
    expect(loadState("paired_ganglions")).toEqual([{ device_id: "new-laptop" }]);
  });

  it("keeps the approval inbox across a restart", async () => {
    const db = fakePool();
    await initState(db.pool);
    const { createApprovalPermissionProvider, inboxSize, restoreInbox, clearInbox } = await import("../../../src/brain/approvals.ts");
    clearInbox();
    const provider = createApprovalPermissionProvider({ record: async () => {}, ask: async () => ({ approved: false, unanswered: true, reason: "later" }) });
    const tool = { name: "open_app_or_url", originalName: "open_app_or_url", qualifiedName: "mcp__laptop__open_app_or_url", permission: "action" } as never;
    await provider.authorize({ tool, arguments: { name: "calculator" } });
    await flushState();
    expect(inboxSize()).toBe(1);

    await initState(db.pool); // the restart
    restoreInbox();
    expect(inboxSize()).toBe(1);
    clearInbox();
  });
});
