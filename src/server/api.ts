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

/* ------------------------------------------------------- task history */

export const fetchTaskHistory = createServerFn({ method: "GET" }).handler(async () => {
  const { getTaskHistory } = await import("~/server/manager");
  return getTaskHistory();
});

export interface TaskDetailInput {
  taskId: string;
}

export const fetchTaskDetail = createServerFn({ method: "POST" })
  .validator((input: unknown): TaskDetailInput => {
    if (typeof input === "object" && input !== null && typeof (input as { taskId?: unknown }).taskId === "string") {
      return { taskId: (input as { taskId: string }).taskId };
    }
    throw new Error("Expected { taskId: string }");
  })
  .handler(async ({ data }) => {
    const { getTaskDetail } = await import("~/server/manager");
    return getTaskDetail(data.taskId);
  });

/* ------------------------------------------------------------- agents */

export const fetchAgentsState = createServerFn({ method: "GET" }).handler(async () => {
  const { getAgentsState } = await import("~/server/manager");
  return getAgentsState();
});

export interface AgentToggleInput {
  agentId: string;
  enabled: boolean;
}

export const setAgentEnabled = createServerFn({ method: "POST" })
  .validator((input: unknown): AgentToggleInput => {
    const o = input as { agentId?: unknown; enabled?: unknown } | null;
    if (typeof o === "object" && o !== null && typeof o.agentId === "string" && typeof o.enabled === "boolean") {
      return { agentId: o.agentId, enabled: o.enabled };
    }
    throw new Error("Expected { agentId: string, enabled: boolean }");
  })
  .handler(async ({ data }) => {
    const { setAgentEnabledState } = await import("~/server/manager");
    return setAgentEnabledState(data.agentId, data.enabled);
  });

/* ----------------------------------------------------- saved research */

export const fetchSavedLibrary = createServerFn({ method: "GET" }).handler(async () => {
  const { getSavedLibrary } = await import("~/server/manager");
  return getSavedLibrary();
});

export interface SaveResultInput {
  taskId: string;
}

export const saveResultToLibrary = createServerFn({ method: "POST" })
  .validator((input: unknown): SaveResultInput => {
    if (typeof input === "object" && input !== null && typeof (input as { taskId?: unknown }).taskId === "string") {
      return { taskId: (input as { taskId: string }).taskId };
    }
    throw new Error("Expected { taskId: string }");
  })
  .handler(async ({ data }) => {
    const { saveResultToLibrary } = await import("~/server/manager");
    return saveResultToLibrary(data.taskId);
  });

export interface DeleteSavedInput {
  id: string;
}

export const deleteSavedResearch = createServerFn({ method: "POST" })
  .validator((input: unknown): DeleteSavedInput => {
    if (typeof input === "object" && input !== null && typeof (input as { id?: unknown }).id === "string") {
      return { id: (input as { id: string }).id };
    }
    throw new Error("Expected { id: string }");
  })
  .handler(async ({ data }) => {
    const { deleteSavedResearch } = await import("~/server/manager");
    return deleteSavedResearch(data.id);
  });
