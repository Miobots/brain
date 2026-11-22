import { initAudit, postgresAuditStore, verifyAudit } from "../brain/audit.ts";

/** `bun run audit:verify` — walk the whole log and name the first edited row (B5.5, G3.2). */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}
await initAudit(postgresAuditStore(url));
const chain = await verifyAudit();
console.log(chain.ok ? `OK: all ${chain.checked} rows verify.` : `TAMPERED: row ${chain.first_bad_id} does not match (checked ${chain.checked} rows).`);
process.exit(chain.ok ? 0 : 1);
