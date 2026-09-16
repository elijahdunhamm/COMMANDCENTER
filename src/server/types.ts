/**
 * Core domain types for the AI Command Center.
 *
 * Contract: an agent receives a task, uses permitted tools, produces a
 * structured result, and reports to the Manager Agent. Statuses reflect
 * reality only; nothing here is ever faked.
 */

export type AgentId = "manager" | "research" | "coding" | "opportunity" | "dealfinder";

export type Intent = "research" | "coding" | "opportunity" | "dealfinder";

/** Agent lifecycle status. Always derived from real runs, never assumed.
 *  "disabled" is the owner's deliberate off state, never a hidden error. */
export type AgentStatus = "idle" | "working" | "waiting" | "completed" | "failed" | "disabled";

export type TaskStatus = "queued" | "working" | "completed" | "failed";

export type RunStatus = "working" | "completed" | "failed";

/** How the command was classified: LLM when configured, deterministic rules otherwise. */
export type RouterKind = "llm" | "fallback";

/** A permitted external call an agent made while executing a task. */
export interface ToolCall {
  /** Tool name, e.g. "wikipedia.summary". */
  tool: string;
  /** The actual request URL (or a precise description for local tools). */
  request: string;
  /** HTTP status code, when the tool made a network call. */
  status: number | null;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/** Where a piece of result data came from. Required on every external field. */
export interface Provenance {
  source: string;
  url: string;
  fetchedAt: string;
}

/** A capability that is registered but not implemented yet. Never fakes output. */
export interface CapabilityMissingResult {
  kind: "agent.capability_missing";
  agentId: AgentId;
  message: string;
}

/** A refusal recorded when the owner disabled the agent. Nothing was executed. */
export interface DisabledAgentResult {
  kind: "agent.disabled";
  agentId: AgentId;
  message: string;
}

export interface SummarySection {
  text: string | null;
  title: string | null;
  articleUrl: string | null;
  provenance: Provenance;
}

export interface PlaceSection {
  displayName: string | null;
  lat: number | null;
  lon: number | null;
  category: string | null;
  osmUrl: string | null;
  provenance: Provenance;
}

/** Structured output of the Research Agent (the one functional capability). */
export interface ResearchBriefResult {
  kind: "research.brief";
  subject: string;
  summary: SummarySection | null;
  place: PlaceSection | null;
  /** Honest notes about what could not be verified. */
  notes: string[];
}

export type ResultPayload =
  | ResearchBriefResult
  | CapabilityMissingResult
  | DisabledAgentResult;

/** Static registry entry. Agents are configuration, not hard-wired paths. */
export interface AgentSpec {
  id: AgentId;
  name: string;
  kind: "manager" | "specialist";
  description: string;
  /** "ready" = has at least one real capability. "awaiting" = registered, not implemented. */
  capability: "ready" | "awaiting";
  /** Human-readable list of what actually works. */
  capabilities: string[];
  handlesIntents: Intent[];
}

/** Registry entry plus the owner's enable/disable control. The Manager Agent
 *  cannot be disabled: it is the router every task passes through. */
export interface RegisteredAgent extends AgentSpec {
  enabled: boolean;
}

export interface Task {
  id: string;
  command: string;
  intent: Intent | null;
  router: RouterKind | null;
  status: TaskStatus;
  agentId: AgentId | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  taskId: string;
  agentId: AgentId;
  status: RunStatus;
  toolCalls: ToolCall[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Message {
  id: string;
  taskId: string | null;
  /** "user" = the owner's command. "manager" = the Manager Agent's honest report. */
  role: "user" | "manager";
  content: string;
  createdAt: string;
}

export interface ResultRecord {
  id: string;
  taskId: string;
  runId: string;
  agentId: AgentId;
  kind: ResultPayload["kind"];
  payload: ResultPayload;
  createdAt: string;
}

/** A research result the owner explicitly saved to the library. The payload is
 *  a copy taken at save time, provenance included; deleting the original task
 *  history does not alter it. */
export interface SavedRecord {
  id: string;
  resultId: string;
  taskId: string;
  agentId: AgentId;
  kind: ResultPayload["kind"];
  payload: ResultPayload;
  createdAt: string;
}

/** Everything persisted about one task, for the detail timeline view. */
export interface TaskDetail {
  task: Task;
  runs: AgentRun[];
  messages: Message[];
  result: ResultRecord | null;
}

/** Live agent view: registry info plus a status derived from real runs. */
export interface AgentView extends RegisteredAgent {
  status: AgentStatus;
  lastRunAt: string | null;
  activeTaskId: string | null;
}
