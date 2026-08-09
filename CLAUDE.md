# Brain — decides and remembers

**Brain is the part that decides things and remembers things.** It never moves a wheel, and it is
never allowed to be the reason something physical stops working.

Brain decides *what* and *why*. Heart decides *how* and *whether* — and **Heart can refuse**, so
every path that sends a command must handle refusal gracefully and explain it to the user.

---

## Non-negotiable rules

**Node and TypeScript only. No Python anywhere in this component** — stricter than the Heart
ruling, and deliberately so.

**`llm.ts` is the only file permitted to import a vendor SDK.** If a second file imports it, the
swap-in-one-file property is already gone and nobody notices until the swap is attempted.

**Memory grounding is enforced in code, not in the prompt.** If retrieval returns zero rows, the
language model is **never called** — return "I have no record of that". A robot inventing where
someone's medication is, is a harm rather than an error, so it cannot rest on a prompt instruction
that a clever phrasing might slip past.

**Facts are superseded, never overwritten.** Closing a validity window and inserting a new row.
Overwrite instead and nothing looks broken until retrieval surfaces a *stale* location because it
happened to be phrased more like the question.

**Recognition is personalisation, never authorization.** Knowing who is speaking loads their
preferences. It must never be the sole gate on a security-sensitive action.

**Allow-list, never deny-list.** A language model routes around a deny-list without intending to,
just by finding a phrasing nobody anticipated. A tool that was never registered cannot be reached
by any phrasing at all.

**Validate every inbound message at the boundary.** TypeScript's types vanish at runtime and the
sender is a different language on a different machine.

**Brain publishes only the cloud-tier half of the capability manifest.** Heart publishes what Heart
can verify. Brain must not report on navigation or battery; Heart must not report on smart home or
Ganglion.

---

## The rule that governs every new feature

Before adding anything, ask: **"does losing Brain break this?"** If yes, it either moves to Heart
or it is openly labelled online-only. Never quietly assumed always-available.

This is not a preference. The business model is a one-time hardware purchase with no mandatory
subscription — a robot that bricks on a Wi-Fi drop is a subscription product wearing a
one-time-purchase price tag.

---

## Run

```bash
npm install
npm start        # Node 26 runs TypeScript directly — no build step
npm test
```

## Build order — this matters more than it looks

**Prove the transport before adding the LLM.** Add both at once and, when nothing arrives, you
cannot tell which half is broken. Debugging a tool-call loop and a WebSocket acknowledgement
protocol simultaneously is how a weekend disappears.

1. `hub.ts` — WebSocket server, dev-token check, `sendCommand` that resolves on ACK and **rejects
   on timeout**. A command that vanishes must error, never hang.
2. Prove it with a hardcoded send, no LLM.
3. `llm.ts`, `tools.ts` (one tool: `speak`), `agent.ts` with a capped iteration count.
4. Done means: `curl -X POST localhost:8080/dev/utterance -d '{"text":"say salam in urdu"}'` makes
   the fake robot speak.

**Memory starts as one table with the dumbest search that works** — Postgres trigram matching, not
vectors. Vectors need embeddings, which needs an open decision nobody has information to make yet.
The lexical version failing on a real query set is also the *baseline* that makes the eventual
upgrade a measured before-and-after rather than one unanchored number.

## Current state

**Scaffold only.** `src/index.ts` prints a line and exits. Postgres is not wired up and should not
be until there is something to store.

## Where the design lives

- `../../03 Engineering/Components/Brain/BRAIN_SPEC.md` — what and why
- `../../03 Engineering/Components/Brain/BRAIN_DECISIONS.md` — **wins over the spec on conflict**
- `../../03 Engineering/Components/Brain/BRAIN_TASKS.md` — nine phases with exit checks
- `../../03 Engineering/Protocol/ENVELOPE.md` — the wire protocol
