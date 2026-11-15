import { createInterface } from "node:readline/promises";
import type { MCPAgentResult, MCPModelRole, OutputBlock } from "../agents/mcp-agent/types.ts";

interface MCPDevReply extends Partial<MCPAgentResult> {
  error?: string;
  connectedServers?: Array<{ id: string; name: string }>;
}

const args = process.argv.slice(2);
const serverId = optionValue(args, "--server") ?? process.env.MCP_SERVER_ID;
const modelRole = (optionValue(args, "--model-role") ?? process.env.MCP_MODEL_ROLE ?? "fast") as MCPModelRole;
const maxIterationsValue = optionValue(args, "--max-iterations");
const maxIterations = maxIterationsValue === undefined ? undefined : Number(maxIterationsValue);
const url = `http://localhost:${process.env.PORT ?? 8080}/dev/mcp-agent`;
const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`MCP Agent dev chat -> ${url}`);
console.log(`model role: ${modelRole}${serverId ? ` | server: ${serverId}` : " | servers: all connected"}`);
console.log("Commands: :quit to exit\n");

try {
  for (;;) {
    const instruction = (await rl.question("mcp-you > ")).trim();
    if (!instruction) continue;
    if (instruction === ":quit") break;

    const startedAt = Date.now();
    console.log("[MCP DEV CLIENT] sending request");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instruction,
          ...(serverId ? { server_id: serverId } : {}),
          model_role: modelRole,
          ...(maxIterations === undefined ? {} : { max_iterations: maxIterations }),
        }),
      });
      const reply = await response.json() as MCPDevReply;
      if (!response.ok || reply.status !== "completed") {
        console.log(`[MCP DEV CLIENT] request failed (HTTP ${response.status})`);
        if (reply.error) console.log(`error: ${reply.error}`);
        for (const error of reply.errors ?? []) console.log(`error [${error.code}]: ${error.message}`);
        if (reply.connectedServers?.length) {
          console.log(`connected servers: ${reply.connectedServers.map((server) => `${server.name} (${server.id})`).join(", ")}`);
        }
      } else {
        console.log(`mcp-mio > ${renderOutput(reply.output ?? [])}`);
        console.log(`tools: ${(reply.toolCalls ?? []).map((call) => call.toolName).join(", ") || "none"}`);
        console.log(
          `[MCP DEV CLIENT] completed iterations=${reply.iterations ?? 0} ` +
          `modelCalls=${reply.modelCalls ?? 0} mcpCalls=${reply.mcpCalls ?? 0} ` +
          `durationMs=${Date.now() - startedAt}\n`,
        );
      }
    } catch (error) {
      console.log(`[MCP DEV CLIENT] Brain unavailable at ${url}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
} finally {
  rl.close();
}

function optionValue(values: string[], option: string): string | undefined {
  const index = values.indexOf(option);
  return index >= 0 ? values[index + 1] : undefined;
}

function renderOutput(blocks: OutputBlock[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case "text": return block.text;
      case "json": return JSON.stringify(block.value);
      case "resource": return `[resource ${block.resource.uri ?? block.resource.artifactId}]`;
      case "image": return `[image ${block.mediaType ?? "artifact"}]`;
      case "audio": return `[audio ${block.mediaType ?? "artifact"}]`;
      case "file": return `[file ${block.filename ?? block.mediaType ?? "artifact"}]`;
    }
  }).filter(Boolean).join("\n") || "(no output)";
}
