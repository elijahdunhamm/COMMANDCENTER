import type { AgentSpec, Task, ToolCall, ResultPayload } from "../types";

/** Real-time tool-call reporting. The Manager passes an implementation that
 *  emits orchestration events; agents call it as each call starts and ends.
 *  Optional: agents must work correctly without one (tests, direct use). */
export interface ToolCallReporter {
  /** Fired immediately before the tool performs its work. */
  started(call: { tool: string; request: string }): void;
  /** Fired as soon as the tool finished, with the real outcome. */
  finished(call: ToolCall): void;
}

export interface ExecutionContext {
  /** Short noun phrase the Manager extracted from the command. */
  subject: string;
  reporter?: ToolCallReporter;
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
