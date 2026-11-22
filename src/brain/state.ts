import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type pg from "pg";

/**
 * Small Brain state that must survive a restart: the paired laptops, the push tokens and the
 * approval inbox (BRAIN_DECISIONS 30). Each is one JSON document.
 *
 * Without a database each document is a file, as before. With one (`initState(pool)`), documents
 * live in `brain_state`, are read once at start into memory, and every save writes through. A file
 * left from before is imported the first time, so nothing is lost by switching.
 */

const FILES: Record<string, () => string> = {
  paired_ganglions: () => process.env.PAIRED_GANGLIONS_FILE ?? "data/paired-ganglions.json",
  push_tokens: () => process.env.PUSH_TOKENS_FILE ?? "data/push-tokens.json",
  approval_inbox: () => process.env.APPROVAL_INBOX_FILE ?? "data/approval-inbox.json",
};
export type StateKey = keyof typeof FILES;

let db: pg.Pool | undefined;
const cache = new Map<string, unknown>();
let writes: Promise<unknown> = Promise.resolve();

function readFile(key: StateKey): unknown {
  try {
    return JSON.parse(readFileSync(FILES[key]!(), "utf8"));
  } catch {
    return undefined;
  }
}

function writeFile(key: StateKey, value: unknown): void {
  const path = FILES[key]!();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function loadState<T>(key: StateKey): T | undefined {
  return (db ? cache.get(key) : readFile(key)) as T | undefined;
}

export function saveState(key: StateKey, value: unknown): void {
  if (!db) return writeFile(key, value);
  cache.set(key, value);
  const pool = db;
  // ponytail: writes are queued in order and a failure is only logged; the memory copy stays right
  // until the next restart. Make saves awaitable if a lost write ever matters.
  writes = writes.then(() => pool.query(
    "INSERT INTO brain_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, JSON.stringify(value)],
  )).catch((error: Error) => console.warn(`[STATE] could not save ${key}: ${error.message}`));
}

/** Waits for queued writes; for tests and shutdown. */
export function flushState(): Promise<unknown> {
  return writes;
}

/** Moves state into Postgres. Call once at start, before devices connect. */
export async function initState(pool: pg.Pool | undefined): Promise<void> {
  db = undefined;
  cache.clear();
  if (!pool) return;
  await pool.query("CREATE TABLE IF NOT EXISTS brain_state (key text PRIMARY KEY, value jsonb NOT NULL)");
  const rows = (await pool.query<{ key: string; value: unknown }>("SELECT key, value FROM brain_state")).rows;
  for (const row of rows) cache.set(row.key, row.value);
  db = pool;
  for (const key of Object.keys(FILES) as StateKey[]) {
    if (cache.has(key)) continue;
    const fromFile = readFile(key);
    if (fromFile !== undefined) {
      saveState(key, fromFile);
      console.log(`[STATE] imported ${key} from ${FILES[key]!()}`);
    }
  }
  await flushState();
}
