import { createServerFn } from "@tanstack/react-start";

/**
 * Thin server-function bridge. All orchestration, secrets, and storage stay
 * server-side: the heavy modules are dynamically imported inside handlers so
 * they never reach the client bundle.
 */

export interface CommandInput {
  command: string;
}

export const fetchDashboardState = createServerFn({ method: "GET" }).handler(async () => {
  const { getDashboardState } = await import("~/server/manager");
  return getDashboardState();
});

export const submitCommand = createServerFn({ method: "POST" })
  .validator((input: unknown): CommandInput => {
    if (typeof input === "object" && input !== null && typeof (input as { command?: unknown }).command === "string") {
      return { command: (input as { command: string }).command };
    }
    throw new Error("Expected { command: string }");
  })
  .handler(async ({ data }) => {
    const { executeCommand } = await import("~/server/manager");
    return executeCommand(data.command);
  });
