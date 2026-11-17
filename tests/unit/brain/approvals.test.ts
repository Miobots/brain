import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createHash } from "node:crypto";
import {
  APPROVAL_META_KEY,
  canonicalJson,
  createAck,
  decode,
  DeviceRole,
  encode,
  Kind,
  newEnvelope,
  SequenceCounter,
  Topics,
  type ApprovalTicket,
} from "@miobots/protocol";
import { config } from "../../../src/brain/config.ts";
import { askApps, createApprovalPermissionProvider, deliverInbox, inboxSize, setInboxRunner, type ApprovalOutcome } from "../../../src/brain/approvals.ts";
import { toolRegistry } from "../../../src/brain/tools.ts";
import type { RegisteredMCPTool } from "../../../src/agents/mcp-agent/tool-registry.ts";

process.env.PORT = "45904";
// The test server is shared by every file that imports it; several older files assume this token.
process.env.DEV_TOKEN = "test-dev-token";

const tool = (permission: "read" | "action", originalName = "open_app_or_url") =>
  ({ name: originalName, originalName, qualifiedName: `mcp__laptop__${originalName}`, permission }) as unknown as RegisteredMCPTool;
const digest = (args: unknown) => createHash("sha256").update(canonicalJson(args)).digest("hex");

describe("approval permission provider (B5.2, BRAIN_DECISIONS 27)", () => {
  it("lets read tools run without asking anyone", async () => {
    let asked = false;
    const provider = createApprovalPermissionProvider({ ask: async () => { asked = true; return { approved: true, approvedBy: "x" }; } });
    expect(await provider.authorize({ tool: tool("read", "system.get_status"), arguments: {} })).toEqual({ allowed: true });
    expect(asked).toBe(false);
  });

  it("attaches a ticket naming the approver and the exact arguments", async () => {
    const said: string[] = [];
    const provider = createApprovalPermissionProvider({
      announce: async (text) => { said.push(text); },
      ask: async () => ({ approved: true, approvedBy: "synapse-app" }),
    });
    const decision = await provider.authorize({ tool: tool("action"), arguments: { target: "Spotify" } });
    expect(decision.allowed).toBe(true);
    const ticket = (decision as { meta: Record<string, ApprovalTicket> }).meta[APPROVAL_META_KEY]!;
    expect(ticket).toMatchObject({ approved_by: "synapse-app", tool: "open_app_or_url", args_sha256: digest({ target: "Spotify" }) });
    expect(ticket.expires_at).toBeGreaterThan(Date.now());
    expect(said[0]).toContain("open app or url Spotify");
  });

  it("refuses a rejected action, and keeps an unanswered one in the inbox", async () => {
    const rejected = createApprovalPermissionProvider({ ask: async () => ({ approved: false, reason: "no" }) });
    expect(await rejected.authorize({ tool: tool("action"), arguments: {} })).toMatchObject({ allowed: false, code: "approval_rejected" });

    const before = inboxSize();
    const unanswered = createApprovalPermissionProvider({ ask: async () => ({ approved: false, unanswered: true, reason: "Nobody answered." }) });
    expect(await unanswered.authorize({ tool: tool("action"), arguments: { target: "later" } })).toMatchObject({ allowed: false, code: "approval_required" });
    expect(inboxSize()).toBe(before + 1);
  });

  it("runs an inbox item once a phone approves it, using the ticket from that approval (G2.5)", async () => {
    const provider = createApprovalPermissionProvider({ ask: async () => ({ approved: false, unanswered: true, reason: "later" }) });
    await provider.authorize({ tool: tool("action"), arguments: { target: "Docs" } });
    const ran: unknown[] = [];
    setInboxRunner(async (_qualifiedName, args) => {
      // The re-run goes through the same provider, which must not ask again.
      ran.push(await provider.authorize({ tool: tool("action"), arguments: args }));
      return "done";
    });
    await deliverInbox("synapse-app", async () => ({ approved: true, approvedBy: "synapse-app" }) satisfies ApprovalOutcome);
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.every((decision) => (decision as { allowed: boolean }).allowed)).toBe(true);
    expect(inboxSize()).toBe(0);
  });
});

describe("only the phone can approve (G2.4)", () => {
  let serverModule: typeof import("../../../src/brain/server.ts");
  const clients: WebSocket[] = [];

  beforeAll(async () => {
    serverModule = await import("../../../src/brain/server.ts");
  });
  afterEach(() => {
    while (clients.length) clients.pop()?.close();
  });

  function join(deviceId: string, role: DeviceRole): Promise<{ client: WebSocket; seq: SequenceCounter; inbox: ReturnType<typeof decode>[] }> {
    const address = serverModule.wss.address();
    const port = address && typeof address !== "string" ? address.port : config.port;
    return new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      clients.push(client);
      const seq = new SequenceCounter();
      const inbox: ReturnType<typeof decode>[] = [];
      client.on("message", (raw) => {
        const message = decode(raw.toString());
        if (message.topic === Topics.SYS_WELCOME) resolve({ client, seq, inbox });
        else inbox.push(message);
      });
      client.once("open", () => client.send(encode(newEnvelope({
        kind: Kind.CMD, topic: Topics.SYS_HELLO, seq,
        payload: { device_id: deviceId, token: config.devToken, protocol_version: 1, role },
      }))));
      client.once("error", reject);
    });
  }

  async function nextApproval(inbox: ReturnType<typeof decode>[]) {
    for (let i = 0; i < 100; i++) {
      const found = inbox.find((message) => message.topic === Topics.SYS_APPROVAL && message.kind === Kind.CMD);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no sys.approval arrived");
  }

  it("ignores a Heart answering the phone's approval, and takes the phone's answer", async () => {
    const app = await join("approve-app", DeviceRole.SYNAPSE);
    const heart = await join("approve-heart", DeviceRole.HEART);
    const outcome = askApps("ap-g24", "open_app_or_url", { target: "Spotify" }, ["approve-app"], 2_000);
    const request = await nextApproval(app.inbox);
    expect(request.payload).toMatchObject({ approval_id: "ap-g24", tool_name: "open_app_or_url", args: { target: "Spotify" } });

    // A Heart (or anything else) replaying the corr_id is not the connection that was asked.
    heart.client.send(encode(createAck(request, { accepted: true }, heart.seq)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    app.client.send(encode(createAck(request, { accepted: false, reason: "not now" }, app.seq)));

    expect(await outcome).toEqual({ approved: false, reason: "not now" });
  });

  it("is unanswered, not approved, when the phone stays silent", async () => {
    await join("silent-app", DeviceRole.SYNAPSE);
    expect(await askApps("ap-silent", "open_app_or_url", {}, ["silent-app"], 100)).toMatchObject({ approved: false, unanswered: true });
  });

  it("gives the model no tool that could approve anything", () => {
    expect(Object.keys(toolRegistry).filter((name) => /approv/i.test(name))).toEqual([]);
  });
});
