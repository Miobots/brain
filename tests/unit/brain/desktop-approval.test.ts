import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAck, decode, DeviceRole, encode, Kind, newEnvelope, SequenceCounter, Topics } from "@miobots/protocol";

process.env.PORT ??= "45906";
process.env.DEV_TOKEN = "test-dev-token";
process.env.PAIRED_GANGLIONS_FILE = join(mkdtempSync(join(tmpdir(), "brain-desk-")), "paired.json");

const clients: WebSocket[] = [];
afterEach(() => {
  while (clients.length) clients.pop()?.close();
});

describe("a laptop that offers a desktop approval surface (G2.3, BRAIN_DECISIONS 30)", () => {
  it("is asked alongside the phone, and its answer counts; a laptop that did not offer is not asked", async () => {
    const server = await import("../../../src/brain/server.ts");
    const { config } = await import("../../../src/brain/config.ts");
    const { pairDevice } = await import("../../../src/brain/pairing.ts");
    const { askApps } = await import("../../../src/brain/approvals.ts");
    const address = server.wss.address();
    const url = `ws://127.0.0.1:${address && typeof address !== "string" ? address.port : config.port}/ws`;

    const join_ = (deviceId: string, role: DeviceRole, token: string, capabilities?: string[]) =>
      new Promise<{ client: WebSocket; seq: SequenceCounter; inbox: ReturnType<typeof decode>[] }>((resolve, reject) => {
        const client = new WebSocket(url);
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
          payload: { device_id: deviceId, token, protocol_version: 1, role, ...(capabilities ? { capabilities } : {}) },
        }))));
        client.once("error", reject);
      });

    const desk = await join_("desk-laptop", DeviceRole.GANGLION, pairDevice("desk-laptop", "desk"), ["desktop-approval"]);
    const plain = await join_("plain-laptop", DeviceRole.GANGLION, pairDevice("plain-laptop", "plain"));
    const outcome = askApps("ap-desk", "open_app_or_url", { name: "calculator" }, undefined, 2_000);

    let request: ReturnType<typeof decode> | undefined;
    for (let i = 0; i < 100 && !request; i++) {
      request = desk.inbox.find((m) => m.topic === Topics.SYS_APPROVAL && m.kind === Kind.CMD);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(request?.payload).toMatchObject({ approval_id: "ap-desk", args: { name: "calculator" } });
    expect(plain.inbox.some((m) => m.topic === Topics.SYS_APPROVAL)).toBe(false);

    desk.client.send(encode(createAck(request!, { accepted: true }, desk.seq)));
    expect(await outcome).toEqual({ approved: true, approvedBy: "desk-laptop" });
  });
});
