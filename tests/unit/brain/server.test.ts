import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
	DeviceRole,
	Kind,
	Topics,
	decode,
	encode,
	newEnvelope,
} from "@miobots/protocol";

const port = 45871;
const token = "test-dev-token";
process.env.PORT = String(port);
process.env.DEV_TOKEN = token;

let server: typeof import("../../../src/brain/server.ts");

function connect() {
	return new Promise<WebSocket>((resolve, reject) => {
		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		client.once("open", () => resolve(client));
		client.once("error", reject);
	});
}

function receive(client: WebSocket) {
	return new Promise<ReturnType<typeof decode>>((resolve, reject) => {
		client.once("message", (data) => {
			try {
				const raw = data instanceof ArrayBuffer ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : data;
				resolve(decode(raw));
			} catch (error) {
				reject(error);
			}
		});
		client.once("error", reject);
	});
}

function hello(tokenValue: string, payloadOverrides: Record<string, unknown> = {}) {
	return newEnvelope({
		kind: Kind.CMD,
		topic: Topics.SYS_HELLO,
		payload: {
			device_id: "heart-test-1",
			token: tokenValue,
			protocol_version: 1,
			role: DeviceRole.HEART,
			...payloadOverrides,
		},
	});
}

describe("brain WebSocket server", () => {
	beforeAll(async () => {
		server = await import("../../../src/brain/server.ts");
		await new Promise<void>((resolve) => {
			if (server.wss.address()) {
				resolve();
			} else {
				server.wss.once("listening", resolve);
			}
		});
	});



	it("accepts a hello with the configured token", async () => {
		const client = await connect();
		const request = hello(token);
		client.send(encode(request));

		const response = await receive(client);
		expect(response.topic).toBe(Topics.SYS_WELCOME);
		expect(response.kind).toBe(Kind.ACK);
		expect(response.corr_id).toBe(request.corr_id);
		expect(response.payload).toMatchObject({ accepted: true });

		client.close();
	});

	it("rejects an incorrect token and closes the client", async () => {
		const client = await connect();
		client.send(encode(hello("wrong-token")));

		const response = await receive(client);
		expect(response.payload).toMatchObject({
			accepted: false,
			reason: "Unauthenticated token",
		});
		await expect(new Promise<void>((resolve) => client.once("close", () => resolve()))).resolves.toBeUndefined();
	});

	it("rejects an invalid hello payload and closes the client", async () => {
		const client = await connect();
		client.send(encode(hello(token, { device_id: "" })));

		const response = await receive(client);
		expect(response.payload).toMatchObject({
			accepted: false,
			reason: "invalid payload",
		});
		await expect(new Promise<void>((resolve) => client.once("close", () => resolve()))).resolves.toBeUndefined();
	});

	it("ignores valid envelopes for topics other than sys.hello", async () => {
		const client = await connect();
		client.send(
			encode(
				newEnvelope({
					kind: Kind.CMD,
					topic: Topics.VOICE_SPEAK,
					payload: { text: "hello" },
				}),
			),
		);

		await expect(
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 100);
				client.once("message", () => {
					clearTimeout(timer);
					reject(new Error("server unexpectedly replied to voice.speak"));
				});
			}),
		).resolves.toBeUndefined();
		client.close();
	});
});
