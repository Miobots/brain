import { createHash } from "node:crypto";
import pg from "pg";
import { canonicalJson, type AuditEntry, type AuditEvent, type AuditView, type JsonObject } from "@miobots/protocol";

/**
 * The one tamper-evident log (B5.4, B5.5, G3.1; BRAIN_DECISIONS 29, GANGLION_DECISIONS 27).
 *
 * Every laptop tool call is a row, written *before* the call goes out; each row's hash covers the
 * row and the previous row's hash, so editing any old row breaks every hash after it. The table is
 * append-only in Postgres itself (a trigger refuses UPDATE and DELETE). The kill switch's state is
 * the newest kill switch row, so it survives a restart and every flip is in the chain.
 */

export type NewAuditEntry = { event: AuditEvent; tool?: string; args?: JsonObject; approved_by?: string };

export interface AuditStore {
  /** Appends one chained row. Must serialize against other appends. */
  append(entry: NewAuditEntry): Promise<AuditEntry>;
  /** Every row, oldest first. */
  all(): Promise<AuditEntry[]>;
}

export function rowHash(prevHash: string, row: Pick<AuditEntry, "id" | "at_ms" | "event"> & NewAuditEntry): string {
  const body = canonicalJson({
    id: row.id,
    at_ms: row.at_ms,
    event: row.event,
    tool: row.tool ?? null,
    args: row.args ?? null,
    approved_by: row.approved_by ?? null,
  });
  return createHash("sha256").update(prevHash + body).digest("hex");
}

/** Walks the chain from the first row and names the first one that doesn't match (B5.5). */
export function verifyRows(rows: AuditEntry[]): AuditView["chain"] {
  let prev = "";
  for (const row of rows) {
    if (row.prev_hash !== prev || rowHash(prev, row) !== row.hash) return { ok: false, checked: rows.length, first_bad_id: row.id };
    prev = row.hash;
  }
  // ponytail: removing the newest rows leaves a valid shorter chain; anchor the head hash elsewhere if that matters.
  return { ok: true, checked: rows.length };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigint PRIMARY KEY,
  at_ms       bigint NOT NULL,
  event       text   NOT NULL,
  tool        text,
  args        jsonb,
  approved_by text,
  prev_hash   text   NOT NULL,
  hash        text   NOT NULL
);
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
`;

type Row = { id: string; at_ms: string; event: AuditEvent; tool: string | null; args: JsonObject | null; approved_by: string | null; prev_hash: string; hash: string };

function fromRow(row: Row): AuditEntry {
  return {
    id: Number(row.id),
    at_ms: Number(row.at_ms),
    event: row.event,
    ...(row.tool !== null ? { tool: row.tool } : {}),
    ...(row.args !== null ? { args: row.args } : {}),
    ...(row.approved_by !== null ? { approved_by: row.approved_by } : {}),
    prev_hash: row.prev_hash,
    hash: row.hash,
  };
}

export function postgresAuditStore(connectionString: string): AuditStore & { ready: Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 3 });
  pool.on("error", (error) => console.warn(`[AUDIT] database connection error: ${error.message}`));
  const ready = pool.query(SCHEMA).then(() => undefined);
  return {
    ready,
    async append(entry) {
      await ready;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // ponytail: one table lock per append serializes the chain; fine at household rates.
        await client.query("LOCK TABLE audit_log IN EXCLUSIVE MODE");
        const last = (await client.query<{ id: string; hash: string }>("SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1")).rows[0];
        const row = { id: last ? Number(last.id) + 1 : 1, at_ms: Date.now(), ...entry };
        const prev_hash = last?.hash ?? "";
        const hash = rowHash(prev_hash, row);
        await client.query(
          "INSERT INTO audit_log (id, at_ms, event, tool, args, approved_by, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [row.id, row.at_ms, row.event, row.tool ?? null, row.args ? JSON.stringify(row.args) : null, row.approved_by ?? null, prev_hash, hash],
        );
        await client.query("COMMIT");
        return { ...row, prev_hash, hash };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async all() {
      await ready;
      return (await pool.query<Row>("SELECT * FROM audit_log ORDER BY id")).rows.map(fromRow);
    },
  };
}

/** For tests: the same chain in memory. */
export function memoryAuditStore(): AuditStore & { rows: AuditEntry[] } {
  const rows: AuditEntry[] = [];
  return {
    rows,
    async append(entry) {
      const row = { id: rows.length + 1, at_ms: Date.now(), ...entry };
      const prev_hash = rows.at(-1)?.hash ?? "";
      const full = { ...row, prev_hash, hash: rowHash(prev_hash, row) };
      rows.push(full);
      return full;
    },
    async all() {
      return [...rows];
    },
  };
}

let store: AuditStore | undefined;
let killSwitch = false;

/** Called once at start-up. Without a database every laptop tool refuses: nothing runs unrecorded. */
export async function initAudit(next: AuditStore | undefined): Promise<void> {
  store = next;
  killSwitch = false;
  if (!store) {
    console.warn("[AUDIT] DATABASE_URL is not set: laptop tools will refuse, because nothing may run unrecorded.");
    return;
  }
  try {
    const last = (await store.all()).filter((row) => row.event !== "tool_call").at(-1);
    killSwitch = last?.event === "killswitch_on";
    console.log(`[AUDIT] ready; kill switch ${killSwitch ? "ON" : "off"}`);
  } catch (error) {
    console.warn(`[AUDIT] could not read the log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Records one laptop tool call. Throws when it can't, and the caller must then refuse the call. */
export async function recordToolCall(tool: string, args: Record<string, unknown>, approvedBy?: string): Promise<void> {
  if (!store) throw new Error("The audit log is not set up (no DATABASE_URL).");
  const row = await store.append({ event: "tool_call", tool, args: JSON.parse(JSON.stringify(args)) as JsonObject, ...(approvedBy ? { approved_by: approvedBy } : {}) });
  console.log(`[AUDIT] row ${row.id} tool=${tool}${approvedBy ? ` approved_by=${approvedBy}` : ""}`);
}

export function killSwitchActive(): boolean {
  return killSwitch;
}

/**
 * Flips the kill switch for app `by`. Switching on always takes effect, even if the row can't be
 * written: a safety control must not depend on the database. Switching off needs the row.
 */
export async function setKillSwitch(active: boolean, by: string): Promise<{ accepted: boolean; reason?: string }> {
  if (active) killSwitch = true;
  try {
    if (!store) throw new Error("The audit log is not set up.");
    await store.append({ event: active ? "killswitch_on" : "killswitch_off", approved_by: by });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[AUDIT] kill switch ${active ? "on" : "off"} not recorded: ${reason}`);
    if (!active) return { accepted: false, reason: `Laptop access stays off: ${reason}` };
  }
  killSwitch = active;
  console.log(`[AUDIT] kill switch ${active ? "ON" : "off"} by=${by}`);
  return { accepted: true };
}

/** The newest rows and the whole chain's verification, for the app (S5.2). */
export async function auditView(limit = 50): Promise<AuditView> {
  if (!store) throw new Error("The audit log is not set up.");
  const rows = await store.all();
  return { entries: rows.slice(-Math.min(limit, 200)).reverse(), chain: verifyRows(rows) };
}

export async function verifyAudit(): Promise<AuditView["chain"]> {
  if (!store) throw new Error("The audit log is not set up.");
  return verifyRows(await store.all());
}
