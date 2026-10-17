# miobots-brain

The part of MioBots that decides and remembers. TypeScript on Bun. See `CLAUDE.md` for the rules that
apply here.

```bash
bun install          # re-run after ANY change to miobots-protocol — see CLAUDE.md
cp .env.example .env # then set AI_PROVIDER_GROQ_API_KEY for /dev/utterance
bun start            # hub on ws://127.0.0.1:8080/ws
bun test
bun run typecheck
```

| Endpoint | Does |
|---|---|
| `ws://…/ws` | The hub. Heart, Synapse and Ganglion dial in and authenticate with `sys.hello` |
| `POST /dev/speak` | `{"text", "lang"}` → `voice.speak` straight to the robot, no LLM |
| `POST /dev/utterance` | `{"text"}` → the ReAct agent loop, which may call tools such as `speak` |
| `GET /health` | Connected devices |

The `/dev/*` endpoints carry no token, which is why the hub binds to `127.0.0.1` by default. Set
`HOST=0.0.0.0` only deliberately — for example, so a phone on the same Wi-Fi can reach it.

To try it against the canonical Fake Heart, run `bun run sim` in `../miobots-protocol` alongside,
then:

```bash
curl -X POST localhost:8080/dev/utterance -H 'Content-Type: application/json' \
  -d '{"text":"say salam in urdu"}'
```

Or type to it: `bun run chat` sends each line to `/dev/utterance` and prints the reply and the tools
it called.

### The I3 demo — words to wheels (B2.5)

Three terminals:

```bash
bun start                                         # 1 · Brain (shows tool calls)
FAKE_HEART_NAV_DISTANCE_M=30 bun run sim          # 2 · in ../miobots-protocol — a 15 s drive
bun run chat                                      # 3 · where you type
```

1. `go to the kitchen` — it heads off and the Fake Heart counts down 29, 28, 27…
2. Partway: `stop` — the cancel goes out before it speaks, and the drive ends early.
3. Type `r` + Enter in terminal 2 (refusal on), then `go to the kitchen` again — it explains it
   cannot go because the battery is at 16%.

Design documentation is in the Obsidian vault two levels up; current state is in its `STATUS.md`.
