import {
  Topics,
  Language,
  Priority,
  type SpeakPayload,
} from "@miobots/protocol";
import { sendCommand } from "./hub.ts";
import { devices } from "./server.ts";
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

export const toolRegistry: Record<string, ToolDefinition> = {
  speak: speakTool,
};

export function getTools(): ToolDefinition[] {
  return Object.values(toolRegistry);
}

export function getTool(name: string): ToolDefinition | undefined {
  return toolRegistry[name];
}

export function registerTool(tool: ToolDefinition): void {
  toolRegistry[tool.name] = tool;
}
