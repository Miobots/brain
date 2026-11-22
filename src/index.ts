import "./brain/server.ts";
import { initAudit, postgresAuditStore } from "./brain/audit.ts";
import { config } from "./brain/config.ts";

await initAudit(process.env.DATABASE_URL ? postgresAuditStore(process.env.DATABASE_URL) : undefined);
console.log(`Brain hub listening on :${config.port}`);
