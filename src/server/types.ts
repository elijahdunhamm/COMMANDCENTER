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

/** A refusal recorded because the request violated an agent's safety policy
 *  (for example a Coding Agent path outside its sandbox). The refused action
 *  is named precisely: what was asked, why it was not done. */
export interface AgentRefusalResult {
  kind: "agent.refused";
  agentId: AgentId;
  /** Mechanical reason class, e.g. "outside_workspace". */
  reason: string;
  message: string;
}

/* --------------------------------------------------------- coding (sandbox) */

/** One concrete operation the Coding Agent performed inside its sandbox. */
export interface CodingOperation {
  op: "list" | "read" | "write" | "command";
  /** The path or command line the agent actually acted on. */
  target: string;
  ok: boolean;
  /** Real output excerpt or a precise statement of what happened. */
  detail: string | null;
  /** True when the sandbox policy refused this operation and nothing ran. */
  refused: boolean;
  /** Typed refusal category when refused is true: honest reason code, not prose. */
  refusalKind?: "outside_workspace" | "command_not_allowed" | "unsafe_characters" | "uninterpretable";
}

/** Structured output of the Coding Agent (sandboxed workspace work).
 *  Every operation recorded here really happened inside the sandbox root;
 *  refusals are listed as refused operations, never silently dropped. */
export interface CodingWorkResult {
  kind: "coding.work";
  task: string;
  /** The sandbox root the agent worked in (absolute path, honest scope). */
  workspaceRoot: string;
  operations: CodingOperation[];
  /** Honest notes: unrecognized phrasing, skipped steps, why the task ended. */
  notes: string[];
}

/* ----------------------------------------------------- opportunity (HN+wiki) */

/** One Hacker News story, ranked deterministically from real API fields. */
export interface OpportunityStory {
  objectId: string;
  title: string;
  /** The story's external link, when it has one. */
  url: string | null;
  /** Discussion URL on Hacker News itself. */
  hnUrl: string;
  /** Real fields from the Algolia API; never imputed. */
  points: number;
  numComments: number;
  createdAt: string;
  author: string | null;
  /** 1-based position under the stated deterministic ranking rule. */
  rank: number;
  provenance: Provenance;
}

/** Structured output of the Opportunity Agent (HN + Wikipedia scan). */
export interface OpportunityScanResult {
  kind: "opportunity.scan";
  /** The original subject the agent was handed, kept verbatim. */
  topic: string;
  /** The query string the sources were actually queried with. */
  hnQuery: string;
  /** Honest provenance for hnQuery: "extracted_topic" when the subject was
   *  reduced to its topic, "full_subject" when the subject itself was used. */
  hnQuerySource: "extracted_topic" | "full_subject";
  /** The exact deterministic ranking rule that ordered the stories. */
  rankingRule: string;
  stories: OpportunityStory[];
  wiki: SummarySection | null;
  /** True when the Hacker News source was unreachable/unusable. */
  hnUnavailable: boolean;
  notes: string[];
}

export interface SummarySection {
  text: string | null;
  title: string | null;
  articleUrl: string | null;
  provenance: Provenance;
}

/* ------------------------------------------------ opportunity (lead finder) */

/** One lead: a named, categorized business whose OpenStreetMap record lists
 *  no website. This reports a listing gap in the map data, never a verified
 *  fact about the business; the framing is stated in every result. */
export interface OpportunityLead {
  osmType: string;
  osmId: number;
  osmUrl: string;
  name: string;
  /** The real OpenStreetMap tags this match is based on, e.g. "shop=hairdresser". */
  category: string;
  /** Built only from real addr:* tags; null when OSM lists no address. */
  address: string | null;
  /** From the OSM phone or contact:phone tag only; null when neither is listed. */
  phone: string | null;
  lat: number;
  lon: number;
  /** Computed haversine distance from the search point (labeled as computed). */
  distanceMiles: number;
  distanceKm: number;
  provenance: Provenance;
}

/** Structured output of the Opportunity Agent lead finder ("find leads for X
 *  in Y"): local businesses whose OpenStreetMap listing shows no website.
 *  The same result shape covers the honest ask-for-location, source-
 *  unavailable, and empty-area outcomes; nothing is ever filled in. */
export interface OpportunityLeadsResult {
  kind: "opportunity.leads";
  command: string;
  /** The subject the agent was handed, kept verbatim. */
  subject: string;
  /** The "for X" phrase when present (who the leads are for). Captured for
   *  display only: OpenStreetMap cannot be searched by client fit, so it
   *  never filtered or ranked anything. */
  audience: string | null;
  radiusMiles: number;
  radiusSource: "command" | "default";
  origin: DealFinderOrigin | null;
  /** True when no location could be resolved and the owner is being asked for one. */
  askedForLocation: boolean;
  /** True when the Overpass source was unreachable/unusable after the fallback chain. */
  sourceUnavailable: boolean;
  /** True when identical-query results came from the in-process cache. */
  servedFromCache: boolean;
  /** The exact Overpass request URL when a search was attempted (provenance). */
  overpassUrl: string | null;
  /** The endpoint that actually answered (null when none did). */
  servedBy: string | null;
  /** True when the answering endpoint was not the first candidate. */
  fallbackUsed: boolean;
  /** How many elements the Overpass query returned (null when no search ran). */
  elementsFetched: number | null;
  /** Hard cap on leads listed per result. */
  leadCap: number;
  leads: OpportunityLead[];
  /** The exact deterministic ranking rule that ordered the leads. */
  rankingRule: string;
  /** The honesty framing, present in EVERY result: leads mean no website
   *  listed on OpenStreetMap, a listing gap, not a verified fact. */
  websiteListingNote: string;
  notes: string[];
}

export interface PlaceSection {
  displayName: string | null;
  lat: number | null;
  lon: number | null;
  category: string | null;
  osmUrl: string | null;
  provenance: Provenance;
}

/** Provenance for a summary that was resolved through the Wikipedia search
 *  fallback after the direct title lookup returned 404. Both URLs are real
 *  requests that were actually made, in order. */
export interface ResearchSummaryFallback {
  /** The direct summary request that failed with 404. */
  failedSummaryUrl: string;
  /** The Wikipedia search request that produced the candidate article. */
  searchUrl: string;
  /** Title of the article search actually returned. */
  articleTitle: string;
  /** URL of the article the quoted summary came from. */
  articleUrl: string;
}

/** Structured output of the Research Agent (the one functional capability). */
export interface ResearchBriefResult {
  kind: "research.brief";
  subject: string;
  summary: SummarySection | null;
  /** Set only when the summary came from the search fallback path. */
  summaryFallback?: ResearchSummaryFallback | null;
  place: PlaceSection | null;
  /** Honest notes about what could not be verified. */
  notes: string[];
}

/* ------------------------------------------------- dealfinder (local search) */

/** Where a local search was centered. Provenance is null only when the owner
 *  supplied coordinates directly in the command (there is no upstream to cite). */
export interface DealFinderOrigin {
  kind: "coordinates" | "geocoded";
  /** Human-readable origin, e.g. "30.2672, -97.7431 (supplied in the command)" */
  label: string;
  lat: number;
  lon: number;
  provenance: Provenance | null;
}

/** Price on a DealFinder hit. OSM carries no price data, so a price is NEVER
 *  invented: this structure exists to make that honesty machine-readable. */
export interface DealFinderPrice {
  verified: false;
  display: "not verified";
  /** Why the price could not be verified (source carries no price data). */
  explanation: string;
}

/** One normalized business from OpenStreetMap, ranked by computed distance. */
export interface DealFinderHit {
  osmType: string;
  osmId: number;
  osmUrl: string;
  name: string | null;
  /** The real OpenStreetMap tags this match is based on, e.g. "shop=hairdresser". */
  category: string;
  lat: number;
  lon: number;
  /** Computed haversine distance from the search point (labeled as computed). */
  distanceMiles: number;
  distanceKm: number;
  address: string | null;
  phone: string | null;
  website: string | null;
  openingHours: string | null;
  price: DealFinderPrice;
  /** "Why this matches" line built only from real dimensions. */
  why: string;
  provenance: Provenance;
}

/** Structured output of the DealFinder Agent (local-service search). */
export interface DealFinderSearchResult {
  kind: "dealfinder.search";
  command: string;
  service: { key: string; label: string; matchedKeyword: string } | null;
  /** Specialty phrases captured from the command. Always marked unsearchable:
   *  OpenStreetMap does not index hairstyles or specialties. */
  specialties: string[];
  /** Always false: the flag exists so clients can assert the honesty. */
  specialtySearchable: false;
  radiusMiles: number;
  radiusSource: "command" | "default";
  maxPrice: { amount: number; currency: "USD" } | null;
  origin: DealFinderOrigin | null;
  /** True when no location could be resolved and the owner is being asked for one. */
  askedForLocation: boolean;
  /** True when the Overpass source was unreachable/unusable after retries. */
  sourceUnavailable: boolean;
  /** True when identical-query results came from the in-process cache. */
  servedFromCache: boolean;
  /** The exact Overpass request URL when a search was attempted (provenance). */
  overpassUrl: string | null;
  results: DealFinderHit[];
  notes: string[];
}

export type ResultPayload =
  | ResearchBriefResult
  | DealFinderSearchResult
  | CodingWorkResult
  | OpportunityScanResult
  | OpportunityLeadsResult
  | CapabilityMissingResult
  | DisabledAgentResult
  | AgentRefusalResult;

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

/* ------------------------------------------------------------- events */

/**
 * Real orchestration events, emitted by the Manager/agent loop as each step
 * actually happens and persisted via the store. Nothing here is synthesized:
 * if an event exists, the thing it names really happened. Events are small
 * and carry no secrets (no env values, no API keys, no credentials).
 */
export type OrchestrationEventType =
  | "task.queued"
  | "task.classified"
  | "run.started"
  | "tool_call.started"
  | "tool_call.finished"
  | "message.added"
  | "run.completed"
  | "run.failed"
  | "task.completed"
  | "task.failed";

export interface OrchestrationEvent {
  /** Monotonic sequence number within the store (1-based). Gaps never occur
   *  in normal operation; clients use it as a cursor ("give me everything
   *  after seq N"). */
  seq: number;
  id: string;
  type: OrchestrationEventType;
  taskId: string | null;
  runId: string | null;
  agentId: AgentId | null;
  /** ISO timestamp of when the step really happened. */
  at: string;
  /** Small, secret-free details (intent, tool name, request URL, duration...). */
  data: Record<string, unknown>;
}
