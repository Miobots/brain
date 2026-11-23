// Every test run keeps Brain state in a temp folder, never in the repo's data/ (BRAIN_DECISIONS 30).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "brain-test-state-"));
process.env.PAIRED_GANGLIONS_FILE ??= join(dir, "paired-ganglions.json");
process.env.PUSH_TOKENS_FILE ??= join(dir, "push-tokens.json");
process.env.APPROVAL_INBOX_FILE ??= join(dir, "approval-inbox.json");
