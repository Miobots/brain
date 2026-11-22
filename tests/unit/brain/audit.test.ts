import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry, DeviceRole as Role } from "@miobots/protocol";
import { auditView, initAudit, killSwitchActive, memoryAuditStore, recordToolCall, setKillSwitch, verifyRows } from "../../../src/brain/audit.ts";
import { createApprovalPermissionProvider } from "../../../src/brain/approvals.ts";
import { createAskLaptopTool, LAPTOP_SWITCHED_OFF } from "../../../src/brain/tools.ts";
import type { RegisteredMCPTool } from "../../../src/agents/mcp-agent/tool-registry.ts";

const tool = (permission: "read" | "action", originalName: string) =>
  ({ name: originalName, originalName, qualifiedName: `mcp__laptop__${originalName}`, permission }) as unknown as RegisteredMCPTool;

async function chain(): Promise<AuditEntry[]> {
  const store = memoryAuditStore();
  await initAudit(store);
  await recordToolCall("open_app_or_url", { target: "calculator" }, "synapse-app");
  await recordToolCall("system.get_status", {});
  await setKillSwitch(true, "synapse-app");
  return store.rows;
}

afterEach(async () => {
  await initAudit(undefined);
});

describe("the hash chain (B5.4, B5.5)", () => {
  it("verifies a clean log, with the approver on action rows only", async () => {
    const rows = await chain();
    expect(verifyRows(rows)).toEqual({ ok: true, checked: 3 });
    expect(rows[0]).toMatchObject({ id: 1, tool: "open_app_or_url", approved_by: "synapse-app", prev_hash: "" });
    expect(rows[1]!.approved_by).toBeUndefined();
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
  });

  it("names the row whose arguments were edited", async () => {
    const rows = await chain();
    rows[0] = { ...rows[0]!, args: { target: "rm -rf" } };
    expect(verifyRows(rows)).toEqual({ ok: false, checked: 3, first_bad_id: 1 });
  });

  it("names the row whose approver was changed", async () => {
    const rows = await chain();
    rows[1] = { ...rows[1]!, approved_by: "someone-else" };
    expect(verifyRows(rows).first_bad_id).toBe(2);
  });

  it("catches a deleted row at the row after it, and a reorder", async () => {
    const rows = await chain();
    expect(verifyRows([rows[0]!, rows[2]!]).first_bad_id).toBe(3);
    expect(verifyRows([rows[1]!, rows[0]!, rows[2]!]).first_bad_id).toBe(2);
  });

  it("gives the app the newest rows first and the chain's state", async () => {
    await chain();
    const view = await auditView(2);
    expect(view.entries.map((row) => row.id)).toEqual([3, 2]);
    expect(view.chain).toEqual({ ok: true, checked: 3 });
  });
});

describe("nothing on the laptop runs unrecorded (G3.1)", () => {
  it("writes one row per call, naming the approver of an action", async () => {
    const store = memoryAuditStore();
    await initAudit(store);
    const provider = createApprovalPermissionProvider({ ask: async () => ({ approved: true, approvedBy: "synapse-app" }) });
    expect((await provider.authorize({ tool: tool("read", "system.get_status"), arguments: {} })).allowed).toBe(true);
    expect((await provider.authorize({ tool: tool("action", "open_app_or_url"), arguments: { target: "calculator" } })).allowed).toBe(true);
    expect(store.rows.map((row) => [row.tool, row.approved_by])).toEqual([["system.get_status", undefined], ["open_app_or_url", "synapse-app"]]);
  });

  it("refuses when the row can't be written", async () => {
    const provider = createApprovalPermissionProvider({ ask: async () => ({ approved: true, approvedBy: "synapse-app" }) });
    expect(await provider.authorize({ tool: tool("read", "system.get_status"), arguments: {} })).toMatchObject({ allowed: false, code: "audit_unavailable" });
  });
});

describe("the kill switch (B5.6)", () => {
  it("refuses every laptop tool and ask_laptop itself, and survives a restart", async () => {
    const store = memoryAuditStore();
    await initAudit(store);
    expect(await setKillSwitch(true, "synapse-app")).toEqual({ accepted: true });

    const provider = createApprovalPermissionProvider({ ask: async () => ({ approved: true, approvedBy: "synapse-app" }) });
    expect(await provider.authorize({ tool: tool("read", "system.get_status"), arguments: {} })).toMatchObject({ allowed: false, code: "killswitch" });
    const askLaptop = createAskLaptopTool({ isConnected: () => true, isSwitchedOff: killSwitchActive, run: async () => { throw new Error("must not run"); } });
    expect(await askLaptop.execute!({ task: "open the calculator" })).toEqual({ status: "disabled", message: LAPTOP_SWITCHED_OFF });

    await initAudit(store); // a Brain restart reads the state back from the chain
    expect(killSwitchActive()).toBe(true);
    await setKillSwitch(false, "synapse-app");
    await initAudit(store);
    expect(killSwitchActive()).toBe(false);
  });

  it("switches on even without a database, but won't switch off unrecorded", async () => {
    await initAudit(undefined);
    expect((await setKillSwitch(true, "synapse-app")).accepted).toBe(true);
    expect(killSwitchActive()).toBe(true);
    expect((await setKillSwitch(false, "synapse-app")).accepted).toBe(false);
    expect(killSwitchActive()).toBe(true);
  });
});

describe("the kill switch over the wire (B5.6, S5.3)", () => {
  it("is flipped by the app, turns a paired laptop away, and shows on sys.devices", async () => {
    const { default: WebSocket } = await import("ws");
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { decode, DeviceRole, encode, Kind, newEnvelope, SequenceCounter, Topics } = await import("@miobots/protocol");
    process.env.PORT ??= "45905";
    process.env.DEV_TOKEN = "test-dev-token";
    process.env.PAIRED_GANGLIONS_FILE = join(mkdtempSync(join(tmpdir(), "brain-kill-")), "paired.json");
    const server = await import("../../../src/brain/server.ts");
    const { config } = await import("../../../src/brain/config.ts");
    const { pairDevice } = await import("../../../src/brain/pairing.ts");
    await initAudit(memoryAuditStore());
    const address = server.wss.address();
    const url = `ws://127.0.0.1:${address && typeof address !== "string" ? address.port : config.port}/ws`;

    const hello = (deviceId: string, role: Role, token: string) => new Promise<{ welcome: ReturnType<typeof decode>; client: InstanceType<typeof WebSocket>; inbox: ReturnType<typeof decode>[] }>((resolve, reject) => {
      const client = new WebSocket(url);
      const inbox: ReturnType<typeof decode>[] = [];
      client.on("message", (raw) => {
        const message = decode(raw.toString());
        if (message.topic === Topics.SYS_WELCOME) resolve({ welcome: message, client, inbox });
        else inbox.push(message);
      });
      client.once("open", () => client.send(encode(newEnvelope({ kind: Kind.CMD, topic: Topics.SYS_HELLO, seq: new SequenceCounter(), payload: { device_id: deviceId, token, protocol_version: 1, role } }))));
      client.once("error", reject);
    });
    const until = async <T>(find: () => T | undefined): Promise<T> => {
      for (let i = 0; i < 200; i++) { const found = find(); if (found) return found; await new Promise((r) => setTimeout(r, 10)); }
      throw new Error("timed out");
    };

    const app = await hello("kill-app", DeviceRole.SYNAPSE, config.devToken);
    const command = newEnvelope({ kind: Kind.CMD, topic: Topics.SYS_KILLSWITCH, seq: new SequenceCounter(), payload: { active: true } });
    app.client.send(encode(command));
    const ack = await until(() => app.inbox.find((m) => m.kind === Kind.ACK && m.corr_id === command.corr_id));
    expect(ack.payload).toMatchObject({ accepted: true });
    await until(() => app.inbox.find((m) => m.topic === Topics.SYS_DEVICES && (m.payload as { killswitch_active?: boolean }).killswitch_active === true));

    const token = pairDevice("kill-laptop", "test laptop");
    const laptop = await hello("kill-laptop", DeviceRole.GANGLION, token);
    expect(laptop.welcome.payload).toMatchObject({ accepted: false, reason: "Laptop access is switched off in the app." });

    const audit = newEnvelope({ kind: Kind.CMD, topic: Topics.SYS_AUDIT, seq: new SequenceCounter(), payload: { limit: 10 } });
    app.client.send(encode(audit));
    const view = await until(() => app.inbox.find((m) => m.kind === Kind.ACK && m.corr_id === audit.corr_id));
    expect(view.payload).toMatchObject({ accepted: true, audit: { chain: { ok: true, checked: 1 }, entries: [{ event: "killswitch_on", approved_by: "kill-app" }] } });
    app.client.close();
    laptop.client.close();
  });
});
