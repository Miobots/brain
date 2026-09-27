# Brain (`miobots-brain`) — Antigravity Rules

**Sole decision-maker, intent parser, long-term memory store, and sync authority.** Node/TS/Bun + Postgres (Neon).

---

## Non-Negotiable Invariants

1. **Never Move Wheels:** Brain decides *what* and *why*; Heart decides *how* and *whether*. Brain never generates velocities, trajectories, or reads raw LiDAR scans.
2. **WebSocket Server Hub:** Brain listens on port 8080 (`/ws`). Heart, Synapse, and Ganglion dial *in*.
3. **Bounded ReAct Agent Loop:** LLM tool-calling loop capped at 5 iterations. Vendor SDKs isolated in `src/ai/`.
4. **Physical Context Injection:** On every turn, dynamically inject current room region, battery %, and capability manifest into the system prompt.
5. **Code-Enforced Grounding Floor:** If memory retrieval returns 0 rows, the LLM is **never called**; return deterministic "no record" string.
6. **72-Hour Reminder Window:** Brain expands recurrence rules into concrete occurrences and pushes `sched.window` to Heart.
7. **Permission Tiers & Audit:** `Action`-tier tools block on Synapse mobile approval; executed actions append to SHA-256 hash-chained `audit` table.

---

## Toolchain & Commands (Bun)

```bash
bun install        # Install dependencies (links @miobots/protocol) — re-run after ANY protocol change
bun test           # Run tests
bun run typecheck  # Typecheck
bun run src/index.ts # Start Brain hub
```

`@miobots/protocol` is a `file:` dependency linked as per-file symlinks at install time; files added to
the protocol afterwards are missing from `node_modules` until `bun install` runs again (see `CLAUDE.md`).
