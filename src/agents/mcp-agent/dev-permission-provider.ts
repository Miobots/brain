import type { MCPToolPermissionProvider } from "./tool-executor.ts";

export function createMCPDevPermissionProvider(allowFilesystemActions: boolean, nodeEnv = process.env.NODE_ENV): MCPToolPermissionProvider {
  if (allowFilesystemActions && nodeEnv !== "development") {
    throw new Error("MCP filesystem action auto-approval requires NODE_ENV=development");
  }
  return {
    authorize: async ({ tool, arguments: args }) => {
      if (tool.permission === "read") return { allowed: true };

      const isFilesystemAction = tool.originalName?.startsWith("filesystem.") === true;
      if (!allowFilesystemActions || !isFilesystemAction) {
        return {
          allowed: false,
          code: "permission_denied",
          message: "MCP DEV allows read tools only unless filesystem actions are explicitly enabled",
        };
      }

      if (tool.originalName === "filesystem.delete" && args.confirmed !== true) {
        return {
          allowed: false,
          code: "permission_denied",
          message: "Filesystem deletion requires confirmed: true",
        };
      }

      return { allowed: true };
    },
  };
}
