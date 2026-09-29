import {
  Topics,
  Language,
  Priority,
  type SpeakPayload,
  type AckPayload,
} from "@miobots/protocol";
import { sendCommand } from "./hub.ts";
import { devices } from "./devices.ts";
import { cancelNavigation, navigateTo } from "./navigation.ts";
import type { ToolDefinition } from "../ai/types.ts";

/**
 * Returns the default device_id to target for hardware tool commands.
 * Defaults to the first connected device in the hub, or 'heart-sim-01'.
 */
export function getDefaultDeviceId(): string {
  const firstConnected = devices.keys().next().value;
  return firstConnected ?? "heart-sim-01";
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
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) {
      throw new Error("Missing or empty 'text' argument for speak tool");
    }

    const lang: Language = args.lang === "ur" ? Language.UR : Language.EN;
    const priority: Priority =
      args.priority === "urgent" ? Priority.URGENT : Priority.NORMAL;

    const targetDeviceId =
      typeof args.device_id === "string" && args.device_id.trim().length > 0
        ? args.device_id.trim()
        : getDefaultDeviceId();

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
      goal_id: {
        type: "string",
        description: "Optional goal ID returned by navigate_to. Omit to cancel the active goal on the target device.",
      },
      device_id: {
        type: "string",
        description: "Optional target Heart device ID.",
      },
    },
    required: [],
  },
  execute: async (args: Record<string, unknown>) => {
    const goalId = typeof args.goal_id === "string" ? args.goal_id.trim() : undefined;
    if (args.goal_id !== undefined && !goalId) {
      throw new Error("'goal_id' must be a non-empty string when provided");
    }

    const deviceId = getOptionalDeviceId(args.device_id);
    return cancelNavigation(deviceId, goalId);
  },
};

export const toolRegistry: Record<string, ToolDefinition> = {
  speak: speakTool,
  navigate_to: navigateToTool,
  cancel_navigation: cancelNavigationTool,
};

function getTargetDeviceId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : getDefaultDeviceId();
}

function getOptionalDeviceId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
