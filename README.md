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

Design documentation is in the Obsidian vault two levels up; current state is in its `STATUS.md`.
