import { AGENT_SPECS, resolveAgentByIntent, managerSpec } from "./agents";
import type { AgentExecution } from "./agents/base";
import { getEnvStatus } from "./env";
import { classifyCommand } from "./model";
import { getStore } from "./store";
import type { StorageInfo } from "./store";
import type {
  AgentRun,
  AgentStatus,
  AgentView,
  Message,
  ResultRecord,
  Task,
} from "./types";

/**
 * Manager Agent: interprets the owner's command, classifies intent (LLM when
 * configured, deterministic rules otherwise), creates the task, routes it to
 * the registered specialist agent, tracks the run, and reports honestly to
 * the chat. Every status persisted here reflects something that really
 * happened.
 */

/** Task ids with a run actually in flight in this process (drives "working"). */
const inFlight = new Set<string>();

async function syncRegistry(): Promise<void> {
  const store = getStore();
  for (const spec of AGENT_SPECS) {
    await store.upsertAgent(spec);
  }
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
  await store.createMessage(task.id, "user", trimmed);

  // 1. Interpret and classify.
  const classification = await classifyCommand(trimmed);
  await store.updateTask(task.id, {
    intent: classification.intent,
    router: classification.router,
  });

  // 2. Route to the registered agent for that intent.
  const agent = resolveAgentByIntent(classification.intent);
  await store.updateTask(task.id, { agentId: agent.spec.id, status: "working" });

  const routerLabel =
    classification.router === "llm"
      ? `LLM router (model ${classification.model})`
      : "deterministic fallback router (no LLM configured)";
  await store.createMessage(
    task.id,
    "manager",
    `Classified intent "${classification.intent}" via ${routerLabel}: ${classification.reasoning}. ` +
      `Routing to ${agent.spec.name}.`,
  );

  // 3. Run the agent with real status tracking.
  const run = await store.createRun(task.id, agent.spec.id);
  inFlight.add(task.id);
  let execution: AgentExecution;
  try {
    execution = await agent.execute(
      { ...task, agentId: agent.spec.id, status: "working", intent: classification.intent, router: classification.router },
      { subject: classification.subject },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await store.updateRun(run.id, {
      status: "failed",
      error: msg,
      finishedAt: new Date().toISOString(),
    });
    await store.updateTask(task.id, { status: "failed", error: msg });
    await store.createMessage(
      task.id,
      "manager",
      `Run failed with an unexpected error while executing: ${msg}. ` +
        `The task is marked failed; nothing was fabricated to fill the gap.`,
    );
    inFlight.delete(task.id);
    return { ok: true, taskId: task.id };
  }
  inFlight.delete(task.id);

  await store.updateRun(run.id, {
    status: execution.status,
    toolCalls: execution.toolCalls,
    error: execution.error,
    finishedAt: new Date().toISOString(),
  });

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
  await store.createMessage(
    task.id,
    "manager",
    `${agent.spec.name} run ${execution.status}.${toolBits}${resultBit} ${execution.summary}`,
  );

  return { ok: true, taskId: task.id };
}

/* -------------------------------------------------- status derivation */

function deriveAgentStatus(
  specId: string,
  runs: AgentRun[],
  isManagerInFlight: boolean,
): AgentStatus {
  if (specId === "manager") return isManagerInFlight ? "working" : "idle";
  const mine = runs.filter((r) => r.agentId === specId);
  const active = mine.find((r) => r.status === "working" && inFlight.has(r.taskId));
  if (active) return "working";
  if (mine.length === 0) return "idle";
  const last = mine[0]; // listRecentRuns is newest-first
  if (last.status === "completed") return "completed";
  if (last.status === "failed") return "failed";
  // A run stuck "working" from a previous process (crash mid-run): honest
  // idle, never a fake "working".
  return "idle";
}

export function buildAgentViews(
  runs: AgentRun[],
  isManagerInFlight: boolean,
): AgentView[] {
  return AGENT_SPECS.map((spec) => {
    const mine = runs.filter((r) => r.agentId === spec.id);
    const active = mine.find((r) => r.status === "working" && inFlight.has(r.taskId));
    return {
      ...spec,
      status: deriveAgentStatus(spec.id, runs, isManagerInFlight),
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
      agents: AGENT_SPECS.map((spec) => ({ ...spec, status: "idle", lastRunAt: null, activeTaskId: null })),
      tasks: [],
      messages: [],
      results: {},
      runs: {},
    };
  }

  const [tasks, messages, runs, managerWaiting] = await Promise.all([
    store.listTasks(30),
    store.listMessages(80),
    store.listRecentRuns(120),
    Promise.resolve(inFlight.size > 0),
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

  return {
    storage,
    env: getEnvStatus(),
    agents: buildAgentViews(runs, managerWaiting),
    tasks,
    messages,
    results,
    runs: runsByTask,
  };
}

export { managerSpec };
