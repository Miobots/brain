import { createPool, initAudit, postgresAuditStore } from "./brain/audit.ts";
import { initState } from "./brain/state.ts";
import { restoreInbox } from "./brain/approvals.ts";

// State first, so a laptop that connects at once finds its pairing (BRAIN_DECISIONS 30).
const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : undefined;
await initState(pool);
restoreInbox();
await initAudit(pool ? postgresAuditStore(pool) : undefined);
await import("./brain/server.ts");
const { config } = await import("./brain/config.ts");
console.log(`Brain hub listening on :${config.port}`);
