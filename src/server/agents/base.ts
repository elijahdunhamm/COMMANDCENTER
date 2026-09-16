import type { AgentSpec, Task, ToolCall, ResultPayload } from "../types";

export interface ExecutionContext {
  /** Short noun phrase the Manager extracted from the command. */
  subject: string;
}

export interface AgentExecution {
  status: "completed" | "failed";
  result: ResultPayload | null;
  toolCalls: ToolCall[];
  error: string | null;
  /** One-line honest summary the Manager Agent relays to the chat. */
  summary: string;
}

/**
 * The agent contract: receive a task, use permitted tools, produce a
 * structured result. Never fabricate output; when a capability is missing,
 * say so (see awaitingAgent below).
 */
export interface Agent {
  spec: AgentSpec;
  execute(task: Task, ctx: ExecutionContext): Promise<AgentExecution>;
}

/** Helper for honestly unimplemented agents. */
export function awaitingAgent(spec: AgentSpec): Agent {
  return {
    spec,
    async execute(_task) {
      const message =
        `${spec.name} is registered but has no capabilities implemented yet, ` +
        `so nothing was executed for this task. This is not a silent skip: ` +
        `the task is marked failed and no result was produced.`;
      return {
        status: "failed",
        result: { kind: "agent.capability_missing", agentId: spec.id, message },
        toolCalls: [],
        error: `${spec.id} agent has no registered capabilities yet`,
        summary: message,
      };
    },
  };
}
