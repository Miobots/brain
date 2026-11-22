import { createHash, randomUUID } from "node:crypto";
import {
  APPROVAL_META_KEY,
  canonicalJson,
  DeviceRole,
  ProtocolDefaults,
  Topics,
  type AckPayload,
  type ApprovalPayload,
  type ApprovalTicket,
  type JsonObject,
} from "@miobots/protocol";
import { devices, deviceRoles } from "./devices.ts";
import { sendCommandHandle } from "./hub.ts";
import type { MCPToolPermissionProvider } from "../agents/mcp-agent/tool-executor.ts";
import { killSwitchActive, recordToolCall } from "./audit.ts";

/**
 * Asking a human before a laptop action runs (B5.2, B5.3, G2.3, G2.5; BRAIN_DECISIONS 27).
 *
 * The only way to approve is an ACK to `sys.approval` from an app connection: the hub matches it by
 * corr_id *and* by the connection it was sent on, so a Heart, a laptop or an utterance cannot answer.
 * Voice may announce the request; it can never approve it.
 */

export type ApprovalOutcome =
  | { approved: true; approvedBy: string }
  | { approved: false; reason: string; unanswered?: boolean };

/** How long Ganglion may act on a ticket after the tap. */
const TICKET_TTL_MS = 30_000;
const INBOX_LIMIT = 20;

interface InboxItem {
  approvalId: string;
  toolName: string;
  qualifiedName: string;
  args: Record<string, unknown>;
}

const inbox = new Map<string, InboxItem>();
/** Tickets for inbox items a human has since approved, waiting for the re-run to consume them. */
const preApproved = new Map<string, ApprovalTicket>();
let runLater: ((qualifiedName: string, args: Record<string, unknown>) => Promise<string>) | undefined;
let announceLater: ((text: string) => Promise<void>) | undefined;

const argsDigest = (args: unknown): string => createHash("sha256").update(canonicalJson(args)).digest("hex");
const callKey = (toolName: string, args: unknown): string => `${toolName}\n${argsDigest(args)}`;

function connectedApps(): string[] {
  return [...deviceRoles].filter(([id, role]) => role === DeviceRole.SYNAPSE && devices.has(id)).map(([id]) => id);
}

/** Sends `sys.approval` to every connected app; the first answer wins. */
export function askApps(
  approvalId: string,
  toolName: string,
  args: Record<string, unknown>,
  apps: string[] = connectedApps(),
  timeoutMs: number = ProtocolDefaults.DEFAULT_APPROVAL_TIMEOUT_MS,
): Promise<ApprovalOutcome> {
  if (apps.length === 0) {
    return Promise.resolve({ approved: false, unanswered: true, reason: "No phone is connected to approve it." });
  }
  const payload: ApprovalPayload = {
    approval_id: approvalId,
    tool_name: toolName,
    args: JSON.parse(JSON.stringify(args)) as JsonObject,
    expires_at: Date.now() + timeoutMs,
  };
  const handles = apps.map((id) => sendCommandHandle(id, Topics.SYS_APPROVAL, payload, `approval-${approvalId}-${id}`, payload.expires_at, { timeoutMs }));
  return new Promise((resolve) => {
    let silent = handles.length;
    for (const handle of handles) {
      handle.ack.then(
        (envelope) => {
          const ack = envelope.payload as AckPayload;
          for (const other of handles) if (other !== handle) other.cancel("answered elsewhere");
          resolve(ack.accepted
            ? { approved: true, approvedBy: handle.deviceId }
            : { approved: false, reason: ack.reason ?? "It was rejected on the phone." });
        },
        () => {
          if (--silent === 0) resolve({ approved: false, unanswered: true, reason: "Nobody answered on the phone in time." });
        },
      );
    }
  });
}

function ticket(approvalId: string, approvedBy: string, toolName: string, args: unknown): ApprovalTicket {
  return {
    approval_id: approvalId,
    approved_by: approvedBy,
    tool: toolName,
    args_sha256: argsDigest(args),
    expires_at: Date.now() + TICKET_TTL_MS,
  };
}

/** "open_app_or_url" + {name: "Spotify"} → "open app or url Spotify", for the robot to say. */
function spoken(toolName: string, args: Record<string, unknown>): string {
  const values = Object.values(args).filter((value) => typeof value === "string" || typeof value === "number");
  return [toolName.replace(/[._]/g, " "), ...values].join(" ");
}

/**
 * Read tools run; Action tools wait for a tap. On approval the call carries a ticket in `_meta`, and
 * Ganglion checks it against the exact arguments. An unanswered request goes to the inbox, never
 * silently away.
 */
export function createApprovalPermissionProvider(options: {
  announce?: (text: string) => Promise<void>;
  /** Reach a phone whose app is closed (BRAIN_DECISIONS 28). Fire-and-forget. */
  notify?: () => Promise<void>;
  ask?: typeof askApps;
  /** Writes the audit row before the call runs (G3.1). If it throws, the call is refused. */
  record?: typeof recordToolCall;
} = {}): MCPToolPermissionProvider {
  const ask = options.ask ?? askApps;
  const record = options.record ?? recordToolCall;
  announceLater = options.announce;

  // Exactly one row per executed call, written first: nothing runs unrecorded.
  const allow = async (toolName: string, args: Record<string, unknown>, ticket?: ApprovalTicket) => {
    try {
      await record(toolName, args, ticket?.approved_by);
    } catch (error) {
      console.warn(`[AUDIT] refused ${toolName}: ${error instanceof Error ? error.message : String(error)}`);
      return { allowed: false as const, code: "audit_unavailable" as const, message: "The audit log can't be written right now, so the laptop wasn't used." };
    }
    return ticket ? { allowed: true as const, meta: { [APPROVAL_META_KEY]: ticket } } : { allowed: true as const };
  };

  return {
    authorize: async ({ tool, arguments: args }) => {
      if (killSwitchActive()) return { allowed: false as const, code: "killswitch" as const, message: "Laptop access is switched off in the app." };
      const toolName = tool.originalName ?? tool.name;
      if (tool.permission === "read") return allow(toolName, args);

      const waiting = preApproved.get(callKey(toolName, args));
      if (waiting) {
        preApproved.delete(callKey(toolName, args));
        return allow(toolName, args, waiting);
      }

      const approvalId = randomUUID();
      void options.announce?.(`I need your OK on your phone to ${spoken(toolName, args)}.`).catch(() => undefined);
      void options.notify?.().catch(() => undefined);
      const outcome = await ask(approvalId, toolName, args);
      if (outcome.approved) {
        console.log(`[APPROVAL] approved id=${approvalId} tool=${toolName} by=${outcome.approvedBy}`);
        return allow(toolName, args, ticket(approvalId, outcome.approvedBy, toolName, args));
      }
      if (outcome.unanswered) {
        addToInbox({ approvalId, toolName, qualifiedName: tool.qualifiedName, args });
        return { allowed: false, code: "approval_required", message: `${outcome.reason} It is waiting in the app's inbox.` };
      }
      console.log(`[APPROVAL] rejected id=${approvalId} tool=${toolName}`);
      return { allowed: false, code: "approval_rejected", message: outcome.reason };
    },
  };
}

function addToInbox(item: InboxItem): void {
  inbox.set(item.approvalId, item);
  while (inbox.size > INBOX_LIMIT) inbox.delete(inbox.keys().next().value!);
  console.log(`[APPROVAL] unanswered, kept in inbox id=${item.approvalId} tool=${item.toolName}`);
}

/** How the inbox re-runs an approved call. Set once by whoever owns the laptop executor. */
export function setInboxRunner(run: (qualifiedName: string, args: Record<string, unknown>) => Promise<string>): void {
  runLater = run;
}

export function inboxSize(): number {
  return inbox.size;
}

/** The kill switch went on: nothing waiting may run later (B5.6). */
export function clearInbox(): void {
  inbox.clear();
  preApproved.clear();
}

/**
 * An app has just connected: ask it again about everything nobody answered (G2.5). Approving runs
 * the exact stored call; rejecting drops it; silence leaves it in the inbox.
 */
export async function deliverInbox(appId: string, ask: typeof askApps = askApps): Promise<void> {
  for (const item of [...inbox.values()]) {
    const outcome = await ask(item.approvalId, item.toolName, item.args, [appId]);
    if (!outcome.approved && outcome.unanswered) continue;
    inbox.delete(item.approvalId);
    if (!outcome.approved || !runLater) continue;
    const key = callKey(item.toolName, item.args);
    preApproved.set(key, ticket(item.approvalId, outcome.approvedBy, item.toolName, item.args));
    const result = await runLater(item.qualifiedName, item.args).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    preApproved.delete(key);
    await announceLater?.(result).catch(() => undefined);
  }
}
