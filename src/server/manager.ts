import { AGENT_SPECS, resolveAgentByIntent, managerSpec } from "./agents";
import type { AgentExecution, ToolCallReporter } from "./agents/base";
import { getEnvStatus } from "./env";
import { classifyCommand } from "./model";
import { getStore } from "./store";
import type { StorageInfo } from "./store";
import type {
  AgentRun,
  AgentStatus,
  AgentView,
  Message,
  OrchestrationEvent,
  OrchestrationEventType,
  RegisteredAgent,
  ResultRecord,
  SavedRecord,
  Task,
  TaskDetail,
} from "./types";

/**
 * Manager Agent: interprets the owner's command, classifies intent (LLM when
 * configured, deterministic rules otherwise), creates the task, routes it to
 * the registered specialist agent, tracks the run, and reports honestly to
 * the chat. Every status persisted here reflects something that really
 * happened.
 *
 * Every step also emits a real orchestration event (task.queued,
 * task.classified, run.started, tool_call.*, message.added, run.*,
 * task.*) through the store, in the order the steps actually happen. The
 * live view streams exactly these events; nothing is synthesized.
 */

/** Task ids with a run actually in flight in this process (drives "working"). */
const inFlight = new Set<string>();

async function syncRegistry(): Promise<void> {
  const store = getStore();
  for (const spec of AGENT_SPECS) {
    await store.upsertAgent(spec);
  }
}

const randomEventId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

/** Persist one orchestration event. Awaited so events land in the store in
 *  the exact order the steps happen (that order is observable and tested). */
async function emit(
  store: ReturnType<typeof getStore>,
  type: OrchestrationEventType,
  fields: { taskId?: string | null; runId?: string | null; agentId?: string | null; data?: Record<string, unknown> },
): Promise<void> {
  try {
    await store.appendEvent({
      id: randomEventId(),
      type,
      taskId: fields.taskId ?? null,
      runId: fields.runId ?? null,
      agentId: (fields.agentId as OrchestrationEvent["agentId"]) ?? null,
      at: new Date().toISOString(),
      data: fields.data ?? {},
    });
  } catch {
    // A storage hiccup while appending an event must never break the actual
    // orchestration. The event is genuinely missing rather than faked.
  }
}

/** Persist a chat message and emit its message.added event. */
async function addMessage(
  store: ReturnType<typeof getStore>,
  taskId: string,
  role: Message["role"],
  content: string,
): Promise<void> {
  await store.createMessage(taskId, role, content);
  await emit(store, "message.added", {
    taskId,
    data: { role, preview: content.slice(0, 240) },
  });
}

/** Builds the real-time tool-call reporter for a run. Appends are chained so
 *  started/finished pairs land in order without blocking the agent's work.
 *  flush() waits for the chain to drain (called before run completion so the
 *  persisted order matches the real order of operations). */
function makeReporter(
  store: ReturnType<typeof getStore>,
  taskId: string,
  runId: string,
  agentId: string,
): { reporter: ToolCallReporter; flush: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): void => {
    chain = chain.then(fn).catch(() => {});
  };
  return {
    reporter: {
      started(call) {
        enqueue(() =>
          emit(store, "tool_call.started", {
            taskId,
            runId,
            agentId,
            data: { tool: call.tool, request: call.request },
          }),
        );
      },
      finished(call) {
        enqueue(() =>
          emit(store, "tool_call.finished", {
            taskId,
            runId,
            agentId,
            data: {
              tool: call.tool,
              request: call.request,
              status: call.status,
              ok: call.ok,
              durationMs: call.durationMs,
              ...(call.error ? { error: call.error } : {}),
            },
          }),
        );
      },
    },
    async flush() {
      await chain.catch(() => {});
    },
  };
}

export async function executeCommand(
  command: string,
): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  const trimmed = command.trim().slice(0, 2000);
  if (!trimmed) return { ok: false, error: "Command is empty." };

  const store = getStore();
  try {
    await store.ensureReady();
  } catch (err) {
    return {
      ok: false,
      error: `storage unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  await syncRegistry();

  const task = await store.createTask(trimmed);
  await emit(store, "task.queued", { taskId: task.id, data: { command: trimmed } });
  await addMessage(store, task.id, "user", trimmed);

  // 1. Interpret and classify.
  const classification = await classifyCommand(trimmed);
  await store.updateTask(task.id, {
    intent: classification.intent,
    router: classification.router,
  });
  await emit(store, "task.classified", {
    taskId: task.id,
    data: {
      intent: classification.intent,
      router: classification.router,
      subject: classification.subject,
      reasoning: classification.reasoning,
      ...(classification.model ? { model: classification.model } : {}),
    },
  });

  // 2. Route to the registered agent for that intent.
  const agent = resolveAgentByIntent(classification.intent);
  await store.updateTask(task.id, { agentId: agent.spec.id, status: "working" });

  const routerLabel =
    classification.router === "llm"
      ? `LLM router (model ${classification.model})`
      : "deterministic fallback router (no LLM configured)";
  await addMessage(
    store,
    task.id,
    "manager",
    `Classified intent "${classification.intent}" via ${routerLabel}: ${classification.reasoning}. ` +
      `Routing to ${agent.spec.name}.`,
  );

  // 2b. A disabled agent refuses the task. The refusal is a real recorded run
  // with zero tool calls and an explicit result: nothing is executed, and the
  // owner sees exactly why in the feed.
  const registered = await store.getAgent(agent.spec.id);
  if (registered && !registered.enabled) {
    const run = await store.createRun(task.id, agent.spec.id);
    await emit(store, "run.started", {
      taskId: task.id,
      runId: run.id,
      agentId: agent.spec.id,
      data: { refused: true },
    });
    const refusal =
      `${agent.spec.name} is disabled, so this task was refused and nothing was executed. ` +
      `No tools were called and no result was produced. Re-enable the agent on the Agents page ` +
      `to route tasks to it again.`;
    await store.updateRun(run.id, {
      status: "failed",
      toolCalls: [],
      error: "agent disabled by owner; task refused",
      finishedAt: new Date().toISOString(),
    });
    await emit(store, "run.failed", {
      taskId: task.id,
      runId: run.id,
      agentId: agent.spec.id,
      data: { error: "agent disabled by owner; task refused", refused: true },
    });
    await store.saveResult({
      taskId: task.id,
      runId: run.id,
      agentId: agent.spec.id,
      kind: "agent.disabled",
      payload: { kind: "agent.disabled", agentId: agent.spec.id, message: refusal },
    });
    await store.updateTask(task.id, {
      status: "failed",
      error: `${agent.spec.name} is disabled; the task was refused`,
    });
    await emit(store, "task.failed", {
      taskId: task.id,
      agentId: agent.spec.id,
      data: { error: `${agent.spec.name} is disabled; the task was refused` },
    });
    await addMessage(store, task.id, "manager", refusal);
    return { ok: true, taskId: task.id };
  }

  // 3. Run the agent with real status tracking.
  const run = await store.createRun(task.id, agent.spec.id);
  await emit(store, "run.started", {
    taskId: task.id,
    runId: run.id,
    agentId: agent.spec.id,
    data: {},
  });
  inFlight.add(task.id);
  const { reporter, flush } = makeReporter(store, task.id, run.id, agent.spec.id);
  let execution: AgentExecution;
  try {
    execution = await agent.execute(
      { ...task, agentId: agent.spec.id, status: "working", intent: classification.intent, router: classification.router },
      { subject: classification.subject, reporter },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await flush();
    await store.updateRun(run.id, {
      status: "failed",
      error: msg,
      finishedAt: new Date().toISOString(),
    });
    await emit(store, "run.failed", { taskId: task.id, runId: run.id, agentId: agent.spec.id, data: { error: msg } });
    await store.updateTask(task.id, { status: "failed", error: msg });
    await emit(store, "task.failed", { taskId: task.id, agentId: agent.spec.id, data: { error: msg } });
    await addMessage(
      store,
      task.id,
      "manager",
      `Run failed with an unexpected error while executing: ${msg}. ` +
        `The task is marked failed; nothing was fabricated to fill the gap.`,
    );
    inFlight.delete(task.id);
    return { ok: true, taskId: task.id };
  }
  inFlight.delete(task.id);
  // Drain pending tool_call events so the run/task completion events land
  // after them, matching the real order of operations.
  await flush();

  await store.updateRun(run.id, {
    status: execution.status,
    toolCalls: execution.toolCalls,
    error: execution.error,
    finishedAt: new Date().toISOString(),
  });
  await emit(
    store,
    execution.status === "completed" ? "run.completed" : "run.failed",
    {
      taskId: task.id,
      runId: run.id,
      agentId: agent.spec.id,
      data: {
        toolCallCount: execution.toolCalls.length,
        ...(execution.error ? { error: execution.error } : {}),
      },
    },
  );

  // 4. Persist the structured result, if the agent produced one.
  if (execution.result) {
    await store.saveResult({
      taskId: task.id,
      runId: run.id,
      agentId: agent.spec.id,
      kind: execution.result.kind,
      payload: execution.result,
    });
  }

  const finalTaskStatus = execution.status === "completed" ? "completed" : "failed";
  await store.updateTask(task.id, {
    status: finalTaskStatus,
    error: execution.error,
  });
  await emit(
    store,
    finalTaskStatus === "completed" ? "task.completed" : "task.failed",
    {
      taskId: task.id,
      runId: run.id,
      agentId: agent.spec.id,
      data: {
        resultKind: execution.result?.kind ?? null,
        ...(execution.error ? { error: execution.error } : {}),
      },
    },
  );

  // 5. Manager's honest report back to the chat.
  const toolBits =
    execution.toolCalls.length > 0
      ? ` Tool calls: ${execution.toolCalls
          .map((c) => `${c.tool} ${c.ok ? "ok" : `failed (${c.status ?? c.error ?? "error"})`}`)
          .join(", ")}.`
      : " No tool calls were made.";
  const resultBit = execution.result
    ? ` Result kind: ${execution.result.kind}.`
    : " No structured result was produced.";
  await addMessage(
    store,
    task.id,
    "manager",
    `${agent.spec.name} run ${execution.status}.${toolBits}${resultBit} ${execution.summary}`,
  );

  return { ok: true, taskId: task.id };
}

/* -------------------------------------------------- status derivation */

function deriveAgentStatus(
  specId: string,
  enabled: boolean,
  runs: AgentRun[],
  isManagerInFlight: boolean,
): AgentStatus {
  if (specId === "manager") return isManagerInFlight ? "working" : "idle";
  const mine = runs.filter((r) => r.agentId === specId);
  const active = mine.find((r) => r.status === "working" && inFlight.has(r.taskId));
  // Honest precedence: a run actually in flight wins, even if the owner just
  // flipped the switch; otherwise the owner's disabled state shows as such.
  if (active) return "working";
  if (!enabled) return "disabled";
  if (mine.length === 0) return "idle";
  const last = mine[0]; // listRecentRuns is newest-first
  if (last.status === "completed") return "completed";
  if (last.status === "failed") return "failed";
  // A run stuck "working" from a previous process (crash mid-run): honest
  // idle, never a fake "working".
  return "idle";
}

export function buildAgentViews(
  registered: RegisteredAgent[],
  runs: AgentRun[],
  isManagerInFlight: boolean,
): AgentView[] {
  const enabledById = new Map(registered.map((r) => [r.id, r.enabled]));
  return AGENT_SPECS.map((spec) => {
    const mine = runs.filter((r) => r.agentId === spec.id);
    const active = mine.find((r) => r.status === "working" && inFlight.has(r.taskId));
    return {
      ...spec,
      enabled: enabledById.get(spec.id) ?? true,
      status: deriveAgentStatus(spec.id, enabledById.get(spec.id) ?? true, runs, isManagerInFlight),
      lastRunAt: mine[0]?.startedAt ?? null,
      activeTaskId: active?.taskId ?? null,
    };
  });
}

/* ----------------------------------------------------- dashboard state */

export interface DashboardState {
  storage: StorageInfo;
  env: ReturnType<typeof getEnvStatus>;
  agents: AgentView[];
  tasks: Task[];
  messages: Message[];
  results: Record<string, ResultRecord>;
  runs: Record<string, AgentRun[]>;
  /** Saved-library entry per task id, so the UI can show honest save state. */
  savedByTask: Record<string, SavedRecord>;
}

/** Shared tail: sync registry, load runs, derive agent views. */
async function loadCore(store: ReturnType<typeof getStore>): Promise<{
  storage: StorageInfo;
  agents: AgentView[];
  runs: AgentRun[];
}> {
  await store.ensureReady();
  await syncRegistry();
  const [registered, runs] = await Promise.all([store.listAgents(), store.listRecentRuns(200)]);
  return {
    storage: store.info(),
    agents: buildAgentViews(registered, runs, inFlight.size > 0),
    runs,
  };
}

export async function getDashboardState(): Promise<DashboardState> {
  const store = getStore();
  let storage: StorageInfo;
  try {
    await store.ensureReady();
    await syncRegistry();
    storage = store.info();
  } catch (err) {
    return {
      storage: {
        mode: store.mode,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      env: getEnvStatus(),
      agents: AGENT_SPECS.map((spec) => ({
        ...spec,
        enabled: true,
        status: "idle",
        lastRunAt: null,
        activeTaskId: null,
      })),
      tasks: [],
      messages: [],
      results: {},
      runs: {},
      savedByTask: {},
    };
  }

  const [tasks, messages, runs, saved] = await Promise.all([
    store.listTasks(30),
    store.listMessages(80),
    store.listRecentRuns(120),
    store.listSaved(),
  ]);

  const results: Record<string, ResultRecord> = {};
  for (const t of tasks) {
    const r = await store.getResultForTask(t.id);
    if (r) results[t.id] = r;
  }
  const runsByTask: Record<string, AgentRun[]> = {};
  for (const r of [...runs].reverse()) {
    (runsByTask[r.taskId] ??= []).push(r);
  }
  // listSaved is newest-first, so the first hit per task is the newest save.
  const savedByTask: Record<string, SavedRecord> = {};
  for (const s of saved) {
    if (!savedByTask[s.taskId]) savedByTask[s.taskId] = s;
  }

  return {
    storage,
    env: getEnvStatus(),
    agents: buildAgentViews(await store.listAgents(), runs, inFlight.size > 0),
    tasks,
    messages,
    results,
    runs: runsByTask,
    savedByTask,
  };
}

/* --------------------------------------------------------- task history */

export interface TaskHistoryState {
  storage: StorageInfo;
  tasks: Task[];
}

/** Full browsable history (newest first). Both store modes serve this. */
export async function getTaskHistory(limit = 200): Promise<TaskHistoryState> {
  const store = getStore();
  try {
    await store.ensureReady();
    await syncRegistry();
    return { storage: store.info(), tasks: await store.listTasks(limit) };
  } catch (err) {
    return {
      storage: {
        mode: store.mode,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      tasks: [],
    };
  }
}

export interface TaskDetailResponse {
  ok: boolean;
  storage: StorageInfo;
  detail: (TaskDetail & { saved: SavedRecord | null }) | null;
  error: string | null;
}

/** Complete record of one task: command, classification, runs, tool calls,
 *  messages, final result, and whether the result is already saved. Works in
 *  both store modes. */
export async function getTaskDetail(taskId: string): Promise<TaskDetailResponse> {
  const store = getStore();
  try {
    await store.ensureReady();
  } catch (err) {
    return {
      ok: false,
      storage: {
        mode: store.mode,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      detail: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const task = await store.getTask(taskId);
  if (!task) {
    return { ok: true, storage: store.info(), detail: null, error: null };
  }
  const [runs, messages, result] = await Promise.all([
    store.listRunsForTask(taskId),
    store.listMessagesForTask(taskId),
    store.getResultForTask(taskId),
  ]);
  const saved = result ? await store.getSavedByResult(result.id) : null;
  return {
    ok: true,
    storage: store.info(),
    detail: { task, runs, messages, result, saved },
    error: null,
  };
}

/* -------------------------------------------------------- agents state */

export interface AgentsState {
  storage: StorageInfo;
  env: ReturnType<typeof getEnvStatus>;
  agents: AgentView[];
}

export async function getAgentsState(): Promise<AgentsState> {
  const store = getStore();
  try {
    const core = await loadCore(store);
    return { ...core, env: getEnvStatus() };
  } catch (err) {
    return {
      storage: {
        mode: store.mode,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      env: getEnvStatus(),
      agents: AGENT_SPECS.map((spec) => ({
        ...spec,
        enabled: true,
        status: "idle",
        lastRunAt: null,
        activeTaskId: null,
      })),
    };
  }
}

export interface AgentToggleResponse {
  ok: boolean;
  error: string | null;
  agent: RegisteredAgent | null;
}

/**
 * The owner's enable/disable control. The Manager Agent cannot be disabled:
 * it is the router every task passes through, so turning it off would only
 * break the pipeline without an honest meaning.
 */
export async function setAgentEnabledState(
  agentId: string,
  enabled: boolean,
): Promise<AgentToggleResponse> {
  if (agentId === "manager") {
    return {
      ok: false,
      error:
        "The Manager Agent cannot be disabled. It classifies and routes every task; without it no command can run.",
      agent: null,
    };
  }
  const store = getStore();
  try {
    await store.ensureReady();
    await syncRegistry();
  } catch (err) {
    return {
      ok: false,
      error: `storage unavailable: ${err instanceof Error ? err.message : String(err)}`,
      agent: null,
    };
  }
  const updated = await store.setAgentEnabled(agentId, enabled);
  if (!updated) {
    return { ok: false, error: `No registered agent with id "${agentId}".`, agent: null };
  }
  return { ok: true, error: null, agent: updated };
}

/* ------------------------------------------------------ saved research */

export interface SavedLibraryState {
  storage: StorageInfo;
  items: SavedRecord[];
}

export async function getSavedLibrary(): Promise<SavedLibraryState> {
  const store = getStore();
  try {
    await store.ensureReady();
    return { storage: store.info(), items: await store.listSaved() };
  } catch (err) {
    return {
      storage: {
        mode: store.mode,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      items: [],
    };
  }
}

export interface SaveResultResponse {
  ok: boolean;
  savedId: string | null;
  error: string | null;
}

/**
 * Saves a completed research result to the library. Only research briefs are
 * savable (refusals and capability-missing records are not research). Saving
 * the same result twice is idempotent: the existing record comes back.
 */
export async function saveResultToLibrary(taskId: string): Promise<SaveResultResponse> {
  const store = getStore();
  try {
    await store.ensureReady();
  } catch (err) {
    return {
      ok: false,
      savedId: null,
      error: `storage unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = await store.getResultForTask(taskId);
  if (!result) {
    return { ok: false, savedId: null, error: "This task has no result to save." };
  }
  if (result.payload.kind !== "research.brief") {
    return {
      ok: false,
      savedId: null,
      error: "Only research results can be saved to the library. This result is not one.",
    };
  }
  const rec = await store.saveToLibrary({
    resultId: result.id,
    taskId: result.taskId,
    agentId: result.agentId,
    kind: result.kind,
    payload: result.payload,
  });
  return { ok: true, savedId: rec.id, error: null };
}

export interface DeleteSavedResponse {
  ok: boolean;
  error: string | null;
}

export async function deleteSavedResearch(id: string): Promise<DeleteSavedResponse> {
  const store = getStore();
  try {
    await store.ensureReady();
  } catch (err) {
    return {
      ok: false,
      error: `storage unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const deleted = await store.deleteSaved(id);
  if (!deleted) {
    return { ok: false, error: "No saved item with that id. It may already have been deleted." };
  }
  return { ok: true, error: null };
}

/* -------------------------------------------------------- live events */

export interface EventStreamState {
  ok: boolean;
  storage: StorageInfo;
  /** Events after the cursor, ascending by seq, filtered to taskId when one
   *  is given. These are the real persisted orchestration events. */
  events: OrchestrationEvent[];
  /** Highest seq included in this scan (unfiltered). The client advances its
   *  cursor to this so no event is ever skipped between polls. */
  lastSeq: number;
  error: string | null;
}

const EVENT_SCAN_LIMIT = 300;

/**
 * Cursor-based read of the event log. The live view polls this every few
 * hundred milliseconds; with events persisted by the orchestration loop, each
 * poll returns exactly the steps that happened since the last one.
 */
export async function getEventsSince(since: number, taskId?: string): Promise<EventStreamState> {
  const store = getStore();
  try {
    await store.ensureReady();
  } catch (err) {
    return {
      ok: false,
      storage: {
        mode: store.mode,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      events: [],
      lastSeq: since,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const safeSince = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
  const scan = await store.listEventsSince(safeSince, EVENT_SCAN_LIMIT);
  const events = taskId ? scan.filter((e) => e.taskId === taskId) : scan;
  const lastSeq = scan.length > 0 ? scan[scan.length - 1].seq : safeSince;
  return { ok: true, storage: store.info(), events, lastSeq, error: null };
}

export { managerSpec };
