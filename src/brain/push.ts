import { loadState, saveState } from "./state.ts";
import type { PushTokenPayload } from "@miobots/protocol";

/**
 * Push notifications for approvals (BRAIN_DECISIONS 28) — **online-only**.
 *
 * When an approval is waiting, every app that registered a push token gets "Mio wants to use your
 * laptop — open the app to review." The push carries no tool name and no arguments: those, and the
 * Approve button, stay in the app, so nothing about the action passes through Expo or Google. If
 * the push service is down or there is no internet, nothing breaks; the request still waits in the
 * inbox for the next time the app connects.
 */

interface StoredToken {
  token: string;
  platform: PushTokenPayload["platform"];
  updated_at: string;
}

const PUSH_TIMEOUT_MS = 5_000;

// A file, or `brain_state` in Postgres when there is a database (BRAIN_DECISIONS 30).
function load(): Record<string, StoredToken> {
  const parsed = loadState<unknown>("push_tokens");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, StoredToken>) : {};
}

function save(tokens: Record<string, StoredToken>): void {
  saveState("push_tokens", tokens);
}

/** An app told us where to reach it. An empty token unregisters it. */
export function setPushToken(appDeviceId: string, payload: PushTokenPayload): void {
  const tokens = load();
  if (payload.token === "") delete tokens[appDeviceId];
  else tokens[appDeviceId] = { token: payload.token, platform: payload.platform, updated_at: new Date().toISOString() };
  save(tokens);
  console.log(`[PUSH] ${payload.token === "" ? "unregistered" : "registered"} app=${appDeviceId}`);
}

export function pushTokenCount(): number {
  return Object.keys(load()).length;
}

/** Tells every registered phone that an approval is waiting. Never throws, never blocks the approval. */
export async function notifyApprovalWaiting(fetcher: typeof fetch = fetch): Promise<void> {
  const tokens = load();
  const entries = Object.entries(tokens);
  if (entries.length === 0) return;
  const messages = entries.map(([, { token }]) => ({
    to: token,
    title: "Mio wants to use your laptop",
    body: "Open the app to review and approve.",
    data: { kind: "approval" },
    priority: "high",
    sound: "default",
    channelId: "approvals",
  }));
  try {
    const response = await fetcher(process.env.EXPO_PUSH_URL ?? "https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
      },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    const result = (await response.json().catch(() => ({}))) as { data?: { status?: string; details?: { error?: string } }[] };
    // The service says which phones are gone (app uninstalled); stop sending to them.
    const gone = (result.data ?? [])
      .map((ticket, index) => (ticket?.details?.error === "DeviceNotRegistered" ? entries[index]?.[0] : undefined))
      .filter((id): id is string => id !== undefined);
    if (gone.length > 0) {
      const current = load();
      for (const id of gone) delete current[id];
      save(current);
    }
    console.log(`[PUSH] approval notice sent=${messages.length} http=${response.status} dropped=${gone.length}`);
  } catch (error) {
    console.warn(`[PUSH] could not send the approval notice: ${error instanceof Error ? error.message : String(error)}`);
  }
}
