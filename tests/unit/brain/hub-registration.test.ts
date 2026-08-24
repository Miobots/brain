import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import WebSocket from "ws";
import {
  Kind,
  Language,
  Topics,
  createAck,
  decode,
  encode,
  newEnvelope,
  type Envelope,
} from "@miobots/protocol";

process.env.PORT = "45871";
process.env.DEV_TOKEN = "test-dev-token";
process.env.ACK_TIMEOUT = "5000";

let serverModule: typeof import("../../../src/brain/server.ts");
let hubModule: typeof import("../../../src/brain/hub.ts");

function waitForListening() {
  return new Promise<number>((resolve, reject) => {
    const tryResolve = () => {
      const addr = serverModule.wss.address();
      if (addr && typeof addr !== "string") {
        resolve(addr.port);
        return;
      }
      setTimeout(tryResolve, 25);
    };

    tryResolve();
    setTimeout(() => reject(new Error("Brain websocket server did not start in time")), 5000);
  });
}

async function connect(port: number) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function receiveEnvelope(socket: WebSocket) {
  return new Promise<Envelope<string, unknown>>((resolve, reject) => {
    socket.once("message", (raw) => {
      try {
        const data = raw instanceof ArrayBuffer ? Buffer.from(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw;
        resolve(decode(data));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function helloEnvelope(deviceId = "heart-sim-01") {
  return newEnvelope({
    kind: Kind.CMD,
    topic: Topics.SYS_HELLO,
    payload: {
      device_id: deviceId,
      token: process.env.DEV_TOKEN!,
      protocol_version: 1,
      role: "heart",
    },
  });
}

describe("brain hub device registration", () => {
  let port: number;

  beforeAll(async () => {
    serverModule = await import("../../../src/brain/server.ts");
    hubModule = await import("../../../src/brain/hub.ts");
    port = await waitForListening();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      serverModule.wss.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("registers a device after sys.hello and allows sendCommand with ACK", async () => {
    const client = await connect(port);

    client.send(encode(helloEnvelope("heart-sim-01")));
    const welcome = await receiveEnvelope(client);

    expect(welcome.topic).toBe(Topics.SYS_WELCOME);
    expect(welcome.kind).toBe(Kind.ACK);
    expect(welcome.payload).toMatchObject({ accepted: true });
    expect(serverModule.devices.has("heart-sim-01")).toBe(true);

    const commandPromise = hubModule.sendCommand("heart-sim-01", Topics.VOICE_SPEAK, {
      text: "Assalam o alaikum",
      lang: Language.UR,
    });

    const command = await receiveEnvelope(client);
    expect(command.kind).toBe(Kind.CMD);
    expect(command.topic).toBe(Topics.VOICE_SPEAK);
    expect(command.payload).toMatchObject({
      text: "Assalam o alaikum",
      lang: Language.UR,
    });

    const ack = createAck(command, { accepted: true });
    client.send(encode(ack));

    const result = await commandPromise;
    expect(result.corr_id).toBe(command.corr_id);
    expect(result.payload).toMatchObject({ accepted: true });

    client.close();
  });
});
