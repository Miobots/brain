import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, DeviceRole, encode, Kind, newEnvelope, SequenceCounter, Topics, type AckPayload } from "@miobots/protocol";
import { config } from "../../../src/brain/config.ts";
import { confirmPairing, isPairedToken, MAX_WRONG_CODES, requestPairing } from "../../../src/brain/pairing.ts";

process.env.PORT = "45903";
// The test server is shared by every file that imports it; several older files assume this token.
process.env.DEV_TOKEN = "test-dev-token";

let serverModule: typeof import("../../../src/brain/server.ts");
const clients: WebSocket[] = [];

function url(): string {
  const address = serverModule.wss.address();
  return `ws://127.0.0.1:${address && typeof address !== "string" ? address.port : config.port}/ws`;
}

function open(): Promise<{ client: WebSocket; next: () => Promise<ReturnType<typeof decode>>; deviceLists: unknown[] }> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url());
    clients.push(client);
    const inbox: ReturnType<typeof decode>[] = [];
    const deviceLists: unknown[] = [];
    const waiters: ((message: ReturnType<typeof decode>) => void)[] = [];
    client.on("message", (raw) => {
      const message = decode(raw instanceof ArrayBuffer ? Buffer.from(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw);
      if (message.topic === Topics.SYS_HEARTBEAT || message.topic === Topics.CAP_MANIFEST) return;
      if (message.topic === Topics.SYS_DEVICES) {
        deviceLists.push(message.payload);
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else inbox.push(message);
    });
    const next = () => new Promise<ReturnType<typeof decode>>((done) => {
      const queued = inbox.shift();
      if (queued) done(queued);
      else waiters.push(done);
    });
    client.once("open", () => resolve({ client, next, deviceLists }));
    client.once("error", reject);
  });
}

function hello(deviceId: string, token: string, role: DeviceRole, seq = new SequenceCounter()) {
  return encode(newEnvelope({
    kind: Kind.CMD, topic: Topics.SYS_HELLO, seq,
    payload: { device_id: deviceId, token, protocol_version: 1, role },
  }));
}

describe("pairing a laptop (G0.2)", () => {
  beforeAll(async () => {
    serverModule = await import("../../../src/brain/server.ts");
    process.env.PAIRED_GANGLIONS_FILE = join(mkdtempSync(join(tmpdir(), "brain-pair-")), "paired.json");
  });

  afterEach(() => {
    while (clients.length) clients.pop()?.close();
  });

  it("pairs through the app, hands the laptop its own token, and admits only that token", async () => {
    const laptop = await open();
    laptop.client.send(encode(newEnvelope({
      kind: Kind.CMD, topic: Topics.SYS_PAIR, seq: new SequenceCounter(),
      payload: { device_id: "pair-laptop", code: "418902", name: "stb-laptop", protocol_version: 1 },
    })));

    const app = await open();
    const seq = new SequenceCounter();
    app.client.send(hello("pair-app", config.devToken, DeviceRole.SYNAPSE, seq));
    expect((await app.next()).topic).toBe(Topics.SYS_WELCOME);
    // Give the server a beat to register the pending laptop before the code arrives.
    await new Promise((resolve) => setTimeout(resolve, 50));
    app.client.send(encode(newEnvelope({ kind: Kind.CMD, topic: Topics.SYS_PAIR_CONFIRM, seq, payload: { code: "418902" } })));

    const appAck = await app.next();
    expect(appAck.payload).toMatchObject({ accepted: true, name: "stb-laptop" });
    expect((appAck.payload as AckPayload).token).toBeUndefined();

    const laptopAck = (await laptop.next()).payload as AckPayload;
    expect(laptopAck.accepted).toBe(true);
    expect(laptopAck.token).toMatch(/^[0-9a-f]{64}$/);
    expect(isPairedToken("pair-laptop", laptopAck.token!)).toBe(true);

    // The shared dev token no longer admits a laptop; its own token does.
    const withDevToken = await open();
    withDevToken.client.send(hello("pair-laptop", config.devToken, DeviceRole.GANGLION));
    expect((await withDevToken.next()).payload).toMatchObject({ accepted: false });

    const withOwnToken = await open();
    withOwnToken.client.send(hello("pair-laptop", laptopAck.token!, DeviceRole.GANGLION));
    expect((await withOwnToken.next()).payload).toMatchObject({ accepted: true });

    // The app is told the laptop is paired, then that it is online — and never sees a token or hash.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const latest = app.deviceLists.at(-1) as { devices: Record<string, unknown>[] };
    expect(latest.devices).toContainEqual(expect.objectContaining({ device_id: "pair-laptop", name: "stb-laptop", online: true }));
    expect(JSON.stringify(app.deviceLists)).not.toMatch(/token|sha256/);
  });

  it("refuses a wrong code and a malformed pair request", async () => {
    expect(confirmPairing("000000")).toMatchObject({ accepted: false });
    const laptop = await open();
    laptop.client.send(encode(newEnvelope({
      kind: Kind.CMD, topic: Topics.SYS_PAIR, seq: new SequenceCounter(),
      payload: { device_id: "bad", code: "12ab56", name: "x", protocol_version: 1 },
    })));
    expect((await laptop.next()).payload).toMatchObject({ accepted: false, reason: "Invalid pairing request." });
  });

  it("refuses a second laptop waiting with the same code", () => {
    const answers: AckPayload[] = [];
    expect(requestPairing("111111", { deviceId: "a", name: "a", complete: (ack) => answers.push(ack) })).toBeUndefined();
    expect(requestPairing("111111", { deviceId: "b", name: "b", complete: () => {} })).toMatchObject({ accepted: false });
    expect(confirmPairing("111111")).toMatchObject({ accepted: true, name: "a" });
    expect(answers[0]?.accepted).toBe(true);
  });

  it(`turns every waiting laptop away after ${MAX_WRONG_CODES} wrong codes in a row`, () => {
    const answers: AckPayload[] = [];
    requestPairing("222222", { deviceId: "c", name: "c", complete: (ack) => answers.push(ack) });
    for (let i = 0; i < MAX_WRONG_CODES - 1; i++) expect(confirmPairing("999999")).toMatchObject({ accepted: false });
    expect(answers).toHaveLength(0);
    expect(confirmPairing("999999").reason).toMatch(/Too many wrong codes/);
    expect(answers[0]).toMatchObject({ accepted: false });
    // The right code is now useless: that laptop has to show a new one.
    expect(confirmPairing("222222")).toMatchObject({ accepted: false });
  });
});
