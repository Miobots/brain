import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifyApprovalWaiting, pushTokenCount, setPushToken } from "../../../src/brain/push.ts";

const TOKEN = "ExponentPushToken[abc123]";

function fakeExpo(reply: unknown = { data: [{ status: "ok" }] }) {
  const calls: { url: string; body: unknown[] }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("approval push notifications (BRAIN_DECISIONS 28)", () => {
  beforeEach(() => {
    process.env.PUSH_TOKENS_FILE = join(mkdtempSync(join(tmpdir(), "brain-push-")), "push.json");
  });

  it("sends nothing when no app registered", async () => {
    const { calls, fetcher } = fakeExpo();
    await notifyApprovalWaiting(fetcher);
    expect(calls).toHaveLength(0);
  });

  it("tells each registered phone an approval is waiting, without the tool or its arguments", async () => {
    setPushToken("synapse-app", { token: TOKEN, platform: "android" });
    const { calls, fetcher } = fakeExpo();
    await notifyApprovalWaiting(fetcher);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual([expect.objectContaining({ to: TOKEN, title: "Mio wants to use your laptop", channelId: "approvals" })]);
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/open_app_or_url|args|arguments/);
  });

  it("stops sending to a phone the push service says is gone, and to an unregistered app", async () => {
    setPushToken("gone-app", { token: TOKEN, platform: "android" });
    await notifyApprovalWaiting(fakeExpo({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }).fetcher);
    expect(pushTokenCount()).toBe(0);

    setPushToken("app", { token: TOKEN, platform: "ios" });
    setPushToken("app", { token: "", platform: "ios" });
    expect(pushTokenCount()).toBe(0);
  });

  it("never throws when the push service is unreachable", async () => {
    setPushToken("synapse-app", { token: TOKEN, platform: "android" });
    const offline = (async () => { throw new Error("getaddrinfo ENOTFOUND exp.host"); }) as unknown as typeof fetch;
    await expect(notifyApprovalWaiting(offline)).resolves.toBeUndefined();
  });
});
