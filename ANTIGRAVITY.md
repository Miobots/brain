# Brain (`miobots-brain`) — Antigravity Rules

**Sole decision-maker, intent parser, long-term memory store, and sync authority.** Node/TS/Bun + Postgres (Neon).

---

## Non-Negotiable Invariants

1. **Never Move Wheels:** Brain decides *what* and *why*; Heart decides *how* and *whether*. Brain never generates velocities, trajectories, or reads raw LiDAR scans.
2. **WebSocket Server Hub:** Brain listens on port 8080 (`/ws`). Heart, Synapse, and Ganglion dial *in*.
3. **Bounded ReAct Agent Loop:** LLM tool-calling loop capped at 5 iterations. No vendor SDK import outside `src/ai/providers/kinds/` (BRAIN_DECISIONS 14).
4. **Physical Context Injection:** On every turn, dynamically inject current room region, battery %, and capability manifest into the system prompt.
5. **Code-Enforced Grounding Floor:** If memory retrieval returns 0 rows, the LLM is **never called**; return deterministic "no record" string.
6. **72-Hour Reminder Window:** Brain expands recurrence rules into concrete occurrences and pushes `sched.window` to Heart.
7. **Permission Tiers & Audit:** `Action`-tier tools block on Synapse mobile approval; executed actions append to SHA-256 hash-chained `audit` table.
8. **Capture Worker & Seven-Day Window:** Every picture the robot keeps is labelled by a loop over unprocessed capture rows — no job queue, off the request path, through the `vision` capability. Vectors are stored but not searched until `B7.4`; search stays trigram. After 7 days the picture and its scene vector are deleted; an object row is never deleted by age (BRAIN_DECISIONS 25).
9. **Ganglion Behind One Tool:** The main agent reaches Ganglion only through `ask_laptop`, which delegates to the separate MCP agent (`src/agents/mcp-agent/`). Ganglion's tools never enter the main tool list. No daemon connected → return "I can't reach your laptop right now", never throw (BRAIN_DECISIONS 26).
10. **Laptops Pair, Never Share:** A Ganglion is admitted only by its own paired token (`sys.pair` → code typed in the app → `sys.pair_confirm`); Brain stores token hashes only. The shared dev token never admits role `ganglion` (GANGLION_DECISIONS 29).
11. **A Tap, Never a Voice:** Laptop Action tools wait for an ACK to `sys.approval` from an app connection and then carry an approval ticket (`_meta`, exact-argument hash, 30 s, single use). No tool approves; voice only announces; unanswered requests go to the inbox (BRAIN_DECISIONS 27).
12. **Pushes Say Only "Waiting":** Approval pushes (Expo, online-only) carry no tool name or arguments; the details and the Approve button stay in the app. No internet means no push and nothing else changes (BRAIN_DECISIONS 28).

---

## Commits

**One-line commit messages only** — no body. **Never add a `Co-Authored-By: Claude` trailer** or a
"Generated with Claude Code" line, in any commit or PR.

---

## Toolchain & Commands (Bun)

```bash
bun install        # Install dependencies (links @miobots/protocol) — re-run after ANY protocol change
bun test           # Run tests
bun run typecheck  # Typecheck
bun run src/index.ts # Start Brain hub
bun run chat         # Type to the agent; each line goes to /dev/utterance
cp .env.example .env # /dev/utterance needs AI_PROVIDER_GROQ_API_KEY (the `fast` capability)
```

`@miobots/protocol` is a `file:` dependency linked as per-file symlinks at install time; files added to
the protocol afterwards are missing from `node_modules` until `bun install` runs again (see `CLAUDE.md`).
