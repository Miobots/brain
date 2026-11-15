import type { Attachment, ChatSuccess } from "../../ai/types.ts";
import type { ArtifactReference, MCPToolExecutionResult, OutputBlock } from "./types.ts";

export interface ToolObservation {
  content: string;
  attachments: Attachment[];
  output: OutputBlock[];
  error?: { code: string; message: string };
}

export function normalizeToolResult(value: unknown): MCPToolExecutionResult {
  if (isExecutionResult(value)) return value;
  if (typeof value === "string") return { ok: true, output: [{ type: "text", text: value }] };
  if (value === undefined) return { ok: true, output: [] };
  return { ok: true, output: [{ type: "json", value }] };
}

export function createToolObservation(result: MCPToolExecutionResult): ToolObservation {
  const attachments: Attachment[] = [];
  const content: string[] = [];
  for (const block of result.output) {
    if (block.type === "text") {
      content.push(block.text);
    } else if (block.type === "json") {
      content.push(stringify(block.value));
    } else if (block.type === "resource") {
      content.push(`[resource] ${stringify(block.resource)}`);
    } else if (isAttachment(block.source)) {
      attachments.push({
        ...block.source,
        mediaType: block.mediaType ?? block.source.mediaType,
      });
      const mediaType = block.mediaType ?? block.source.mediaType ?? "unknown media type";
      content.push(`[${block.type} attachment: ${mediaType}]`);
    } else {
      content.push(`[${block.type} artifact] ${stringify(block.source)}`);
    }
  }

  const error = result.error ? { code: result.error.code, message: result.error.message } : undefined;
  if (!result.ok && error) content.push(`Tool execution failed (${error.code}): ${error.message}`);
  if (result.ok && content.length === 0 && attachments.length === 0) content.push("Tool returned no output.");
  return { content: content.join("\n"), attachments, output: result.output, ...(error ? { error } : {}) };
}

export function modelOutput(result: ChatSuccess): OutputBlock[] {
  const output: OutputBlock[] = [];
  if (result.text) output.push({ type: "text", text: result.text });
  result.files.forEach((file, index) => {
    output.push({
      type: "file",
      source: {
        source: { data: file.data, filename: `model-output-${index + 1}` },
        mediaType: file.mediaType,
      },
      mediaType: file.mediaType,
    });
  });
  return output;
}

export function collectArtifacts(blocks: OutputBlock[]): ArtifactReference[] {
  return blocks.flatMap((block) => {
    if (block.type === "resource") return [block.resource];
    if ((block.type === "image" || block.type === "audio" || block.type === "file") && !isAttachment(block.source)) {
      return [block.source];
    }
    return [];
  });
}

function isExecutionResult(value: unknown): value is MCPToolExecutionResult {
  return typeof value === "object" && value !== null && "ok" in value &&
    typeof value.ok === "boolean" && "output" in value && Array.isArray(value.output);
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null || !("source" in value)) return false;
  const source = value.source;
  return typeof source === "object" && source !== null &&
    ("path" in source || "url" in source || ("data" in source && source.data instanceof Uint8Array));
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}