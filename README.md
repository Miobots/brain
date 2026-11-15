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
| `POST /dev/utterance` | `{"text"}` → the Brain Tools ReAct loop, which may call native Brain tools such as `speak` |
| `POST /dev/mcp-agent` | `{"instruction"}` → the independent MCP Agent loop, which may call tools from connected MCP servers |
| `GET /health` | Connected devices |

### MCP transport

Allow MCP sessions only for explicitly approved Ganglion device IDs with
`MCP_ALLOWED_GANGLION_DEVICE_IDS=ganglion-laptop-01,ganglion-laptop-02`. An empty or missing
allowlist fails closed for MCP while still allowing the ordinary authenticated device connection.
MCP uses the existing authenticated WebSocket and does not open another listener.

The current development handshake uses a shared `DEV_TOKEN`; it authenticates possession of the
shared token but does not provide cryptographic per-device identity binding. The MCP allowlist is an
additional server-side authorization check, not a replacement for stronger device credentials.

### MCP Agent dev chat

The MCP Agent has its own conversation and execution loop, separate from the Brain Tools Agent.
It discovers tools from authenticated MCP connections, asks the configured model to select tools,
and executes calls through Brain's permission- and schema-validating MCP executor. The development
endpoint is read-only: tools not classified as `read` are denied. MCP tool calls, results, errors,
and progress are logged by the Brain server; prompt and tool-result contents are not logged.

Run Brain, Ganglion, and the interactive client in separate terminals:

```bash
# Terminal 1, in brain/: the hub and MCP Agent endpoint
bun start

# Terminal 2, in ganglion/: connect the allowlisted MCP server to Brain
bun start

# Terminal 3, in brain/: interactive MCP Agent client
bun run mcp-chat
```

Enter a request such as `Check my system status.` Type `:quit` to exit. The client connects to
`POST /dev/mcp-agent` in the Brain server process, so Brain must be running and Ganglion must be
connected and included in `MCP_ALLOWED_GANGLION_DEVICE_IDS`.

The client defaults to model role `fast` and discovers tools on all connected MCP servers. Options:

```bash
bun run mcp-chat -- --server ganglion-laptop-01 --model-role fast --max-iterations 3
```

Supported model roles are `fast`, `vision`, `reasoning`, and `orchestrator`. Configure the matching
`AI_<ROLE>_PROVIDER` and `AI_<ROLE>_MODEL` bindings and provider credentials in `.env`. The agent
switches to the configured `vision` capability after it receives an image result. For example,
the `vision` model must accept image input to answer screenshot questions.

### MCP tool execution

The persistent MCP connection manager owns authenticated sessions and discovery. Phase 5 adds a
separate registry and executor: discovered metadata is namespaced per server, arguments are validated
before execution, and Brain-side permission policy is checked before routing through the manager's
session. The MCP Agent exposes only registered tool schemas to the model and invokes the existing
executor; it does not duplicate MCP connections or execution. Unknown tools, unavailable servers,
malformed schemas, invalid arguments, and unknown permission classes fail closed. Tool results are
normalized into the conversation, including image attachments passed through the shared AI
attachment pipeline.

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
