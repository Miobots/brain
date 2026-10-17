/**
 * Type to the robot: each line goes to POST /dev/utterance, and the reply prints as a sentence plus
 * the tools it called. For demos (B2.5) — the raw curl JSON is unreadable on a recording.
 * Needs the Brain running: `bun start` in another terminal, then `bun run chat`.
 */
import { createInterface } from "node:readline/promises";

const url = `http://localhost:${process.env.PORT ?? 8080}/dev/utterance`;
const rl = createInterface({ input: process.stdin, output: process.stdout });

for (;;) {
    const text = (await rl.question("you › ")).trim();
    if (!text) continue;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
        });
        const reply = (await res.json()) as { text?: string; error?: string; toolCalls?: { name: string }[] };
        const tools = reply.toolCalls?.map((t) => t.name).join(", ");
        console.log(`mio › ${reply.text ?? reply.error}${tools ? `   [${tools}]` : ""}\n`);
    } catch (err) {
        console.log(`(Brain not reachable at ${url}: ${err instanceof Error ? err.message : err})\n`);
    }
}
