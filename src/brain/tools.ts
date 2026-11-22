import {
  Topics,
  Language,
  Priority,
  type SpeakPayload,
  type AckPayload,
} from "@miobots/protocol";
import { sendCommand } from "./hub.ts";
import { resolveHeartDeviceId } from "./devices.ts";
import { cancelNavigation, navigateTo } from "./navigation.ts";
import type { ToolDefinition } from "../ai/types.ts";
import { MCPAgentRunner } from "../agents/mcp-agent/agent.ts";
import { mcpConnectionManager } from "../agents/mcp-agent/manager.ts";
import { MCPToolRegistry } from "../agents/mcp-agent/tool-registry.ts";
import { MCPToolExecutor } from "../agents/mcp-agent/tool-executor.ts";
import { createApprovalPermissionProvider, setInboxRunner } from "./approvals.ts";
import { killSwitchActive } from "./audit.ts";
import { notifyApprovalWaiting } from "./push.ts";
import type { MCPAgentResult } from "../agents/mcp-agent/types.ts";

/**
 * Returns the deterministic authenticated Heart target for hardware tool commands.
 */
export function getDefaultDeviceId(): string {
  return resolveHeartDeviceId();
}

export interface SpeakToolArgs {
  text: string;
  lang?: "en" | "ur";
  priority?: "normal" | "urgent";
  device_id?: string;
}

export const speakTool: ToolDefinition = {
  name: "speak",
  description: "Say something out loud through the robot speaker in English or Urdu.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text/phrase to speak aloud.",
      },
      lang: {
        type: "string",
        enum: ["en", "ur"],
        description: "The language code ('en' for English, 'ur' for Urdu). Defaults to 'en'.",
      },
      priority: {
        type: "string",
        enum: ["normal", "urgent"],
        description: "Speech playback priority ('normal', 'urgent'). Defaults to 'normal'.",
      },
    },
    required: ["text"],
  },
  execute: async (args: Record<string, unknown>) => {
    // Speech engines read markdown aloud, and models like bold numbers.
    const text = typeof args.text === "string" ? args.text.replace(/[*_`#]/g, "").trim() : "";
    if (!text) {
      throw new Error("Missing or empty 'text' argument for speak tool");
    }

    const lang: Language = args.lang === "ur" ? Language.UR : Language.EN;
    const priority: Priority =
      args.priority === "urgent" ? Priority.URGENT : Priority.NORMAL;

    const targetDeviceId = resolveHeartDeviceId(
      typeof args.device_id === "string" && args.device_id.trim().length > 0 ? args.device_id : undefined,
    );

    const payload: SpeakPayload = {
      text,
      lang,
      priority,
    };

    const ack = await sendCommand(targetDeviceId, Topics.VOICE_SPEAK, payload);
    const ackPayload = ack.payload as Partial<AckPayload> | undefined;
    if (ackPayload?.accepted === false) {
      throw new Error(`Heart refused voice.speak: ${ackPayload.reason ?? "no reason given"}`);
    }

    return {
      status: "spoken",
      text,
      lang,
      priority,
      target_device: targetDeviceId,
      ack: ack.payload,
    };
  },
};

export const navigateToTool: ToolDefinition = {
  name: "navigate_to",
  description: "Start driving to a region and return a goal ID immediately while progress arrives later.",
  parameters: {
    type: "object",
    properties: {
      region: {
        type: "string",
        description: "The named region to drive to, such as kitchen.",
      },
      device_id: {
        type: "string",
        description: "Optional target Heart device ID.",
      },
    },
    required: ["region"],
  },
  execute: async (args: Record<string, unknown>) => {
    const region = typeof args.region === "string" ? args.region.trim() : "";
    if (!region) throw new Error("Missing or empty 'region' argument for navigate_to tool");

    const deviceId = getTargetDeviceId(args.device_id);
    return navigateTo(deviceId, region);
  },
};

export const cancelNavigationTool: ToolDefinition = {
  name: "cancel_navigation",
  description: "Cancel the active navigation goal, optionally using its goal ID.",
  parameters: {
    type: "object",
    properties: {
      // `null` is allowed: each utterance is a fresh conversation, so "stop" arrives without the
      // goal ID and models fill the slot with null. Groq rejects that against a string-only schema
      // before the tool runs, and the robot keeps driving.
      goal_id: {
        type: ["string", "null"],
        description: "Optional goal ID returned by navigate_to. Omit or null to cancel the active goal on the target device.",
      },
      device_id: {
        type: ["string", "null"],
        description: "Optional target Heart device ID.",
      },
    },
    required: [],
  },
  execute: async (args: Record<string, unknown>) => {
    const goalId = typeof args.goal_id === "string" ? args.goal_id.trim() : undefined;
    if (args.goal_id != null && !goalId) {
      throw new Error("'goal_id' must be a non-empty string when provided");
    }

    const deviceId = getOptionalDeviceId(args.device_id);
    return cancelNavigation(deviceId, goalId);
  },
};

export const LAPTOP_UNREACHABLE = "I can't reach your laptop right now.";
export const LAPTOP_SWITCHED_OFF = "Laptop access is switched off in the app, so I can't use your laptop.";
export const AUDIT_UNAVAILABLE = "I can't write to the activity log right now, so I didn't use your laptop.";
export const APPROVAL_REJECTED = "That was rejected on your phone, so I didn't do it.";
export const APPROVAL_UNANSWERED = "Nobody approved that on your phone in time, so I haven't done it. It's waiting in the app; approve it there and I'll do it then.";

export interface AskLaptopDependencies {
  isConnected: () => boolean;
  run: (task: string) => Promise<MCPAgentResult>;
  /** The app's kill switch (B5.6). Checked before anything else. */
  isSwitchedOff?: () => boolean;
}

/**
 * The main agent's only door to Ganglion (BRAIN_DECISIONS 26). Never throws: a missing or failing
 * laptop is one failed step, and the rest of the request carries on.
 */
export function createAskLaptopTool(deps: AskLaptopDependencies): ToolDefinition {
  return {
    name: "ask_laptop",
    description:
      "Ask the user's paired laptop to do a task: check its battery or status, find and read files in approved folders, " +
      "look at its screen and say what is on it, play, pause or skip music and change its volume, open a registered app or website, or run a registered script by name. " +
      "Describe the whole task in one sentence; the laptop works out the steps.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The whole laptop task in plain words." },
      },
      required: ["task"],
    },
    execute: async (args: Record<string, unknown>) => {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) return { status: "error", message: "Missing laptop task." };
      if (deps.isSwitchedOff?.()) return { status: "disabled", message: LAPTOP_SWITCHED_OFF };
      if (!deps.isConnected()) return { status: "unavailable", message: LAPTOP_UNREACHABLE };
      try {
        const result = await deps.run(task);
        // Said word for word, never paraphrased: a model asked to "let me know if you'd like me to go
        // ahead" would be inviting a spoken approval, which can never count (BRAIN_DECISIONS 27).
        const codes = result.errors.map((error) => error.code);
        if (codes.includes("killswitch")) return { status: "disabled", message: LAPTOP_SWITCHED_OFF };
        if (codes.includes("audit_unavailable")) return { status: "failed", message: AUDIT_UNAVAILABLE };
        if (codes.includes("approval_rejected")) return { status: "not_approved", message: APPROVAL_REJECTED };
        if (codes.includes("approval_required")) return { status: "not_approved", message: APPROVAL_UNANSWERED };
        const text = result.output
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")
          .trim();
        return result.status === "completed"
          ? { status: "done", answer: text }
          : { status: "failed", message: text || result.errors[0]?.message || "The laptop task failed." };
      } catch (error) {
        return { status: "failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

// Its own executor: the dev endpoint's auto-approval must never be reachable by voice. Read tools
// run; Action tools wait for a tap on the phone, and the robot only announces (BRAIN_DECISIONS 27).
const sayAloud = async (text: string) => { await speakTool.execute!({ text }); };
const laptopRegistry = new MCPToolRegistry(mcpConnectionManager);
const laptopExecutor = new MCPToolExecutor(laptopRegistry, mcpConnectionManager, {
  permissionProvider: createApprovalPermissionProvider({ announce: sayAloud, notify: () => notifyApprovalWaiting() }),
  announceScreenCapture: () => sayAloud("Taking a look at your screen"),
});
const laptopAgent = new MCPAgentRunner({ registry: laptopRegistry, manager: mcpConnectionManager, executor: laptopExecutor });
setInboxRunner(async (qualifiedName, args) => {
  const result = await laptopExecutor.execute(qualifiedName, args);
  return result.ok ? "Done, that laptop request you approved has run." : `That laptop request failed: ${result.error?.message ?? "unknown error"}`;
});

export const askLaptopTool = createAskLaptopTool({
  isConnected: () => mcpConnectionManager.getReadyServers().length > 0,
  isSwitchedOff: killSwitchActive,
  run: (task) => laptopAgent.execute({ instruction: task }, { modelRole: "fast" }),
});

export const toolRegistry: Record<string, ToolDefinition> = {
  speak: speakTool,
  navigate_to: navigateToTool,
  cancel_navigation: cancelNavigationTool,
  ask_laptop: askLaptopTool,
};

function getTargetDeviceId(value: unknown): string {
  return resolveHeartDeviceId(typeof value === "string" && value.trim().length > 0 ? value : undefined);
}

function getOptionalDeviceId(value: unknown): string | undefined {
  return value === undefined || value === null
    ? undefined
    : resolveHeartDeviceId(typeof value === "string" ? value : "");
}

export function getTools(): ToolDefinition[] {
  return Object.values(toolRegistry);
}

export function getTool(name: string): ToolDefinition | undefined {
  return toolRegistry[name];
}

export function registerTool(tool: ToolDefinition): void {
  toolRegistry[tool.name] = tool;
}
