import { describe, expect, it } from "vitest";
import { createAskLaptopTool, LAPTOP_UNREACHABLE, toolRegistry } from "../../../src/brain/tools.ts";
import type { MCPAgentResult } from "../../../src/agents/mcp-agent/types.ts";

function result(overrides: Partial<MCPAgentResult>): MCPAgentResult {
  return {
    taskId: "t", status: "completed", output: [], toolCalls: [], errors: [],
    iterations: 1, modelCalls: 1, mcpCalls: 1, artifacts: [], startedAt: 0, ...overrides,
  };
}

describe("ask_laptop (BRAIN_DECISIONS 26)", () => {
  it("returns the unreachable message without running the agent when no daemon is connected", async () => {
    let ran = false;
    const tool = createAskLaptopTool({ isConnected: () => false, run: async () => { ran = true; return result({}); } });
    expect(await tool.execute!({ task: "battery?" })).toEqual({ status: "unavailable", message: LAPTOP_UNREACHABLE });
    expect(ran).toBe(false);
  });

  it("returns the agent's text answer", async () => {
    const tool = createAskLaptopTool({
      isConnected: () => true,
      run: async () => result({ output: [{ type: "text", text: "41%, not charging" }] }),
    });
    expect(await tool.execute!({ task: "battery?" })).toEqual({ status: "done", answer: "41%, not charging" });
  });

  it("turns a failure or a throw into a result, never an exception", async () => {
    const failed = createAskLaptopTool({
      isConnected: () => true,
      run: async () => result({ status: "failed", errors: [{ code: "x", message: "denied" }] }),
    });
    expect(await failed.execute!({ task: "t" })).toEqual({ status: "failed", message: "denied" });
    const threw = createAskLaptopTool({ isConnected: () => true, run: async () => { throw new Error("socket gone"); } });
    expect(await threw.execute!({ task: "t" })).toEqual({ status: "failed", message: "socket gone" });
  });

  it("is the only laptop tool in the main registry", () => {
    expect(toolRegistry.ask_laptop?.name).toBe("ask_laptop");
  });
});

describe("ask_laptop when a laptop action was not approved (BRAIN_DECISIONS 27)", () => {
  it("says the fixed sentence instead of letting the model invite a spoken yes", async () => {
    const { APPROVAL_REJECTED, APPROVAL_UNANSWERED } = await import("../../../src/brain/tools.ts");
    const rejected = createAskLaptopTool({
      isConnected: () => true,
      run: async () => result({ status: "completed", output: [{ type: "text", text: "Let me know if you'd like me to go ahead." }], errors: [{ code: "approval_rejected", message: "no" }] }),
    });
    expect(await rejected.execute!({ task: "open spotify" })).toEqual({ status: "not_approved", message: APPROVAL_REJECTED });
    const unanswered = createAskLaptopTool({
      isConnected: () => true,
      run: async () => result({ errors: [{ code: "approval_required", message: "later" }] }),
    });
    expect(await unanswered.execute!({ task: "open spotify" })).toEqual({ status: "not_approved", message: APPROVAL_UNANSWERED });
  });
});
