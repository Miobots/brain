import { describe, expect, it } from "vitest";
import { speakUnspokenReply, type AgentResponse } from "../../../src/brain/agent.ts";

const reply = (overrides: Partial<AgentResponse>): AgentResponse => ({
  ok: true, text: "Your laptop is at **100 %**.", correlationId: "c", iterations: 1, toolCalls: [], ...overrides,
});

describe("speakUnspokenReply", () => {
  it("speaks a text-only reply, without markdown", async () => {
    const said: Record<string, unknown>[] = [];
    expect(await speakUnspokenReply(reply({}), async (args) => { said.push(args); })).toBe(true);
    expect(said).toEqual([{ text: "Your laptop is at 100 %.", lang: "en" }]);
  });

  it("speaks Urdu script as Urdu", async () => {
    const said: Record<string, unknown>[] = [];
    await speakUnspokenReply(reply({ text: "سلام" }), async (args) => { said.push(args); });
    expect(said[0]?.lang).toBe("ur");
  });

  it("does not speak twice when the model already called speak, or when the request failed", async () => {
    let calls = 0;
    const speak = async () => { calls++; };
    await speakUnspokenReply(reply({ toolCalls: [{ id: "1", name: "speak", arguments: {}, result: {} }] }), speak);
    await speakUnspokenReply(reply({ ok: false }), speak);
    expect(calls).toBe(0);
  });

  it("never throws when the Heart cannot speak", async () => {
    expect(await speakUnspokenReply(reply({}), async () => { throw new Error("no heart"); })).toBe(false);
  });
});
