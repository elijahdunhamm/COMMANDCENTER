import { useNow } from "~/hooks/useEventStream";
import type { AgentId, AgentView, OrchestrationEvent } from "~/server/types";
import type { ReactNode } from "react";

/**
 * The office floor: five robots, one per agent, animated ONLY by real
 * orchestration events arriving over the same 600ms cursor poll the rest of
 * the dashboard uses. Nothing here is simulated: a robot moves when its
 * agent's run really starts, works while its tool calls really run, and
 * walks back when the run really completes or fails. An agent with no
 * events sits idle at its desk. A disabled agent sits dimmed at its desk.
 *
 * Motion is CSS-only (transform/opacity, transitions plus a few keyframes);
 * no per-frame JS. prefers-reduced-motion renders the scene static.
 * No visible text inside the scene: hover/focus a robot for a tooltip
 * naming the agent and its current real state.
 */

export const AGENT_LABELS: Record<AgentId, string> = {
  manager: "Manager",
  research: "Research",
  coding: "Coding",
  opportunity: "Opportunity",
  dealfinder: "DealFinder",
};

const OFFICE_ORDER: AgentId[] = ["manager", "research", "coding", "opportunity", "dealfinder"];

/** How long the walk between desk and station takes; matches the CSS
 *  transition duration on .office-robot-slot (1.5s). */
const WALK_MS = 1500;
/** How long the satisfied pose (or slump, or refusal note) lingers after a
 *  run ends before the robot settles back into idle. */
const SETTLE_MS = 3200;

export type OfficeMode =
  | "idle"
  | "walking-out"
  | "tool"
  | "reading"
  | "walking-back"
  | "celebrate"
  | "slump"
  | "refused"
  | "routing"
  | "disabled";

export interface OfficeAgentState {
  agentId: AgentId;
  mode: OfficeMode;
  taskId: string | null;
  tool: string | null;
  /** True when the owner has this agent switched off and it has no open run. */
  disabled: boolean;
}

interface OpenRun {
  runId: string;
  taskId: string | null;
  startedAt: string;
  currentTool: { tool: string; startedAt: string } | null;
}

interface TerminalRun {
  at: string;
  taskId: string | null;
  ok: boolean;
  refused: boolean;
}

const STATION_MODES: OfficeMode[] = ["walking-out", "tool", "reading"];
const ACTIVE_LED_MODES: OfficeMode[] = ["walking-out", "tool", "reading", "walking-back", "routing"];

function shortId(taskId: string | null): string {
  return taskId ? taskId.slice(0, 8) : "";
}

/** Tooltip copy. Also the button's accessible name. Zero em-dashes. */
export function tooltipFor(s: OfficeAgentState): string {
  const name = `${AGENT_LABELS[s.agentId]} Agent`;
  const task = s.taskId ? ` (task ${shortId(s.taskId)})` : "";
  switch (s.mode) {
    case "idle":
      return `${name} - idle at desk`;
    case "disabled":
      return `${name} - disabled by the owner`;
    case "routing":
      return `${name} - routing task ${shortId(s.taskId)}`;
    case "walking-out":
      return `${name} - walking to its station${task}`;
    case "tool":
      return `${name} - calling ${s.tool ?? "a tool"}${task}`;
    case "reading":
      return `${name} - working on task ${shortId(s.taskId)}`;
    case "walking-back":
      return `${name} - heading back to its desk`;
    case "celebrate":
      return `${name} - completed task ${shortId(s.taskId)}`;
    case "slump":
      return `${name} - run failed on task ${shortId(s.taskId)}, recovering`;
    case "refused":
      return `${name} - refused a task (nothing was executed)`;
  }
}

/**
 * Pure derivation from real events. Replayed from the event buffer on every
 * tick; the same events always produce the same scene. No state is invented:
 * a mode only exists if the events that cause it really happened.
 */
export function deriveOfficeState(
  events: OrchestrationEvent[],
  agents: AgentView[] | null,
  now: number,
): OfficeAgentState[] {
  const openRuns = new Map<AgentId, OpenRun>();
  const terminals = new Map<AgentId, TerminalRun>();
  const activeTasks = new Set<string>();
  let latestActiveTask: string | null = null;

  for (const e of events) {
    if (e.type === "task.queued" && e.taskId) {
      activeTasks.add(e.taskId);
      latestActiveTask = e.taskId;
    } else if ((e.type === "task.completed" || e.type === "task.failed") && e.taskId) {
      activeTasks.delete(e.taskId);
    }
    if (e.type === "run.started" && e.runId) {
      openRuns.set((e.agentId ?? "research") as AgentId, {
        runId: e.runId,
        taskId: e.taskId,
        startedAt: e.at,
        currentTool: null,
      });
    } else if (e.type === "tool_call.started" && e.runId) {
      const run = openRuns.get((e.agentId ?? "research") as AgentId);
      if (run && run.runId === e.runId) {
        run.currentTool = {
          tool: typeof e.data.tool === "string" ? e.data.tool : "a tool",
          startedAt: e.at,
        };
      }
    } else if (e.type === "tool_call.finished" && e.runId) {
      const run = openRuns.get((e.agentId ?? "research") as AgentId);
      if (run && run.runId === e.runId && run.currentTool?.tool === e.data.tool) {
        run.currentTool = null;
      }
    } else if ((e.type === "run.completed" || e.type === "run.failed") && e.runId) {
      const agentId = (e.agentId ?? "research") as AgentId;
      const run = openRuns.get(agentId);
      if (run && run.runId === e.runId) {
        terminals.set(agentId, {
          at: e.at,
          taskId: e.taskId,
          ok: e.type === "run.completed",
          refused: e.data.refused === true,
        });
        openRuns.delete(agentId);
      }
    }
  }

  return OFFICE_ORDER.map<OfficeAgentState>((agentId) => {
    const run = openRuns.get(agentId);
    if (run) {
      const t = new Date(run.startedAt).getTime();
      const elapsed = Number.isNaN(t) ? WALK_MS + 1 : now - t;
      if (elapsed < WALK_MS) {
        return { agentId, mode: "walking-out", taskId: run.taskId, tool: null, disabled: false };
      }
      if (run.currentTool) {
        return {
          agentId,
          mode: "tool",
          taskId: run.taskId,
          tool: run.currentTool.tool,
          disabled: false,
        };
      }
      return { agentId, mode: "reading", taskId: run.taskId, tool: null, disabled: false };
    }

    const done = terminals.get(agentId);
    if (done) {
      const t = new Date(done.at).getTime();
      const elapsed = Number.isNaN(t) ? SETTLE_MS + 1 : now - t;
      if (elapsed < SETTLE_MS) {
        if (done.refused) {
          return { agentId, mode: "refused", taskId: done.taskId, tool: null, disabled: false };
        }
        if (elapsed < WALK_MS) {
          return { agentId, mode: "walking-back", taskId: done.taskId, tool: null, disabled: false };
        }
        return {
          agentId,
          mode: done.ok ? "celebrate" : "slump",
          taskId: done.taskId,
          tool: null,
          disabled: false,
        };
      }
    }

    if (agentId === "manager" && activeTasks.size > 0) {
      return {
        agentId,
        mode: "routing",
        taskId: latestActiveTask,
        tool: null,
        disabled: false,
      };
    }

    const view = agents?.find((a) => a.id === agentId);
    if (view && !view.enabled) {
      return { agentId, mode: "disabled", taskId: null, tool: null, disabled: true };
    }
    return { agentId, mode: "idle", taskId: null, tool: null, disabled: false };
  });
}

/* --------------------------------------------------------------- figures */

/** CSS-built robot. Distinct silhouette per agent, consistent with the roster:
 *  Manager is the wide supervisor with twin antennae, Research tall and slim,
 *  Coding boxy, Opportunity round, DealFinder capped. Zinc bodies, one chest
 *  LED that carries real semantic state color. */
function RobotFigure({ state }: { state: OfficeAgentState }): ReactNode {
  const { agentId, mode } = state;
  const led =
    mode === "celebrate"
      ? "bg-ok"
      : mode === "slump"
        ? "bg-err"
        : ACTIVE_LED_MODES.includes(mode)
          ? "bg-accent status-working"
          : "bg-[#5b6371]";
  return (
    <span
      aria-hidden
      className="r-fig"
      data-agent={agentId}
      data-mode={mode}
      data-moving={mode === "walking-out" || mode === "walking-back" ? "true" : "false"}
    >
      {agentId === "manager" && (
        <span className="r-antennae">
          <i className="r-ant a-l" />
          <i className="r-ant a-r" />
        </span>
      )}
      {agentId === "research" && (
        <span className="r-antennae">
          <i className="r-ant a-c" />
        </span>
      )}
      <span className="r-head">
        {agentId === "dealfinder" && <i className="r-cap" />}
        <i
          className={
            agentId === "opportunity" ? "r-eye round" : agentId === "coding" ? "r-eye square" : "r-eye"
          }
        />
      </span>
      <span className="r-torso">
        <i className="r-arm a-l" />
        <i className="r-arm a-r" />
        <i className={`r-led ${led}`} />
      </span>
      <span className="r-base" />
    </span>
  );
}

/* ------------------------------------------------------------ scene props */

function StationProps({ agentId, active }: { agentId: AgentId; active: boolean }): ReactNode {
  switch (agentId) {
    case "research":
      return (
        <span className="st-monitor" data-active={active ? "true" : "false"}>
          <i className="st-screen" />
          <i className="st-stand" />
        </span>
      );
    case "dealfinder":
      return (
        <span className="st-printer" data-active={active ? "true" : "false"}>
          <i className="st-slot" />
          <i className="st-sheet" />
        </span>
      );
    case "coding":
      return (
        <span className="st-rack">
          <i />
          <i />
          <i />
        </span>
      );
    case "opportunity":
      return (
        <span className="st-board">
          <i className="st-note" />
        </span>
      );
    default:
      return null;
  }
}

function DeskProps({ agentId, active }: { agentId: AgentId; active: boolean }): ReactNode {
  if (agentId === "manager") {
    return (
      <span className="dk-console" data-active={active ? "true" : "false"}>
        <i className="st-screen" />
        <i className="st-stand" />
      </span>
    );
  }
  return <span className="dk-mat" />;
}

/* ----------------------------------------------------------------- scene */

export function OfficeScene({
  events,
  agents,
  error,
}: {
  events: OrchestrationEvent[];
  agents: AgentView[] | null;
  error: string | null;
  /** Kept for API symmetry with the stream hook; the empty pre-poll event
   *  buffer already derives an all-idle scene. */
  ready?: boolean;
}): ReactNode {
  // Two-pass derivation: decide with a static timestamp whether anyone is
  // mid-motion (walking, working, or settling). Only then does the 500ms
  // clock tick at all, so a fully idle office costs nothing.
  const states0 = deriveOfficeState(events, agents, Date.now());
  const needsClock = states0.some((s) => s.mode !== "idle" && s.mode !== "disabled");
  const now = useNow(needsClock, 500);
  const states = needsClock ? deriveOfficeState(events, agents, now) : states0;

  return (
    <section aria-label="Office floor" className="office-scene panel overflow-hidden">
      <div className="office-room">
        <div className="office-grid">
          {states.map((s) => {
            const pos = STATION_MODES.includes(s.mode) ? "station" : "desk";
            const tip = tooltipFor(s);
            return (
              <div key={s.agentId} className="office-lane" data-agent={s.agentId}>
                <div className="office-station" aria-hidden>
                  <StationProps agentId={s.agentId} active={s.mode === "tool"} />
                </div>
                <div
                  className="office-robot-slot"
                  data-pos={pos}
                  data-disabled={s.disabled ? "true" : "false"}
                >
                  <button type="button" className="office-robot" aria-label={tip}>
                    <RobotFigure state={s} />
                  </button>
                  <span className="office-tip" aria-hidden="true" role="tooltip">
                    {tip}
                  </span>
                </div>
                <div className="office-desk" aria-hidden>
                  <DeskProps agentId={s.agentId} active={s.mode === "routing" || s.mode === "tool"} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {error && (
        <p role="alert" className="border-t hairline px-4 py-2.5 text-xs text-err">
          Live stream error: {error} The scene holds its last real positions until the stream
          reconnects.
        </p>
      )}
    </section>
  );
}
