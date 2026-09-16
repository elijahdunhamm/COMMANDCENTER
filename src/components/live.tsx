import {
  ChatCircle,
  CheckCircle,
  CircleNotch,
  Eye,
  Lightning,
  Play,
  SealCheck,
  TerminalWindow,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { useNow } from "~/hooks/useEventStream";
import type { AgentId, OrchestrationEvent } from "~/server/types";

/**
 * "Through glass" live view. Every row here is a real persisted orchestration
 * event arriving over the stream; nothing is simulated. While a run is in
 * flight the panel grows row by row: classification appears the moment the
 * Manager classifies, each tool call shows a spinner for exactly as long as
 * the call is actually running, then its real status and duration.
 */

const AGENT_LABELS: Record<AgentId, string> = {
  manager: "Manager",
  research: "Research",
  coding: "Coding",
  opportunity: "Opportunity",
  dealfinder: "DealFinder",
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

function eventTime(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  return fmtDuration(now - t);
}

/* ------------------------------------------------- derivation (from events) */

interface OpenRun {
  runId: string;
  agentId: AgentId;
  startedAt: string;
  currentTool: { tool: string; startedAt: string } | null;
}

export interface LiveState {
  /** Runs that started and have no terminal event yet: genuinely in flight. */
  openRuns: OpenRun[];
  /** Newest task id seen in the stream, and whether it reached a terminal
   *  event. The Manager is really orchestrating while a task is open. */
  activeTaskId: string | null;
  activeTaskDone: boolean;
  activeTaskCommand: string | null;
  latest: OrchestrationEvent | null;
}

export function deriveLiveState(events: OrchestrationEvent[]): LiveState {
  const open = new Map<string, OpenRun>();
  let activeTaskId: string | null = null;
  let activeTaskDone = false;
  let activeTaskCommand: string | null = null;
  for (const e of events) {
    if (e.taskId) {
      if (e.taskId !== activeTaskId) {
        activeTaskId = e.taskId;
        activeTaskDone = false;
        activeTaskCommand = null;
      }
      if (e.type === "task.completed" || e.type === "task.failed") activeTaskDone = true;
      if (e.type === "task.queued" && typeof e.data.command === "string") {
        activeTaskCommand = e.data.command;
      }
    }
    if (e.type === "run.started" && e.runId) {
      open.set(e.runId, {
        runId: e.runId,
        agentId: (e.agentId ?? "research") as AgentId,
        startedAt: e.at,
        currentTool: null,
      });
    } else if (e.type === "tool_call.started" && e.runId) {
      const run = open.get(e.runId);
      if (run) {
        run.currentTool = {
          tool: typeof e.data.tool === "string" ? e.data.tool : "tool",
          startedAt: e.at,
        };
      }
    } else if (e.type === "tool_call.finished" && e.runId) {
      const run = open.get(e.runId);
      if (run && run.currentTool?.tool === e.data.tool) run.currentTool = null;
    } else if ((e.type === "run.completed" || e.type === "run.failed") && e.runId) {
      open.delete(e.runId);
    }
  }
  return {
    openRuns: [...open.values()],
    activeTaskId,
    activeTaskDone,
    activeTaskCommand,
    latest: events.length > 0 ? events[events.length - 1] : null,
  };
}

/* ------------------------------------------------------------- live strip */

/**
 * Compact strip of current activity. Agent dots are real semantic state:
 * amber pulsing only while that agent genuinely has an open run.
 */
export function LiveStrip({ events, error }: { events: OrchestrationEvent[]; error: string | null }) {
  const live = deriveLiveState(events);
  const now = useNow(live.openRuns.length > 0 || (live.activeTaskId != null && !live.activeTaskDone));

  const workingAgents = new Map<AgentId, OpenRun>();
  for (const run of live.openRuns) workingAgents.set(run.agentId, run);
  // The Manager genuinely is mid-orchestration while a task is open.
  const managerBusy =
    (live.activeTaskId != null && !live.activeTaskDone) || workingAgents.has("manager");

  const chips: { id: AgentId; working: boolean; elapsed: string | null }[] = (
    Object.keys(AGENT_LABELS) as AgentId[]
  ).map((id) => {
    if (id === "manager") {
      return {
        id,
        working: managerBusy && !workingAgents.has("manager"),
        elapsed: managerBusy && live.latest ? eventTime(live.latest.at, now) : null,
      };
    }
    const run = workingAgents.get(id);
    return run
      ? { id, working: true, elapsed: eventTime(run.startedAt, now) }
      : { id, working: false, elapsed: null };
  });

  let activity: ReactNode;
  if (error) {
    activity = <span className="text-err">Live stream unavailable: {error}</span>;
  } else if (workingAgents.size > 0) {
    const parts = [...workingAgents.values()].map((run) => (
      <span key={run.runId} className="inline-flex items-center gap-1.5">
        {AGENT_LABELS[run.agentId]} Agent
        {run.currentTool ? (
          <>
            {" "}
            calling <span className="mono">{run.currentTool.tool}</span> (
            {fmtDuration(now - new Date(run.currentTool.startedAt).getTime())})
          </>
        ) : (
          <> working ({fmtDuration(now - new Date(run.startedAt).getTime())})</>
        )}
      </span>
    ));
    activity = <span className="flex flex-wrap gap-x-4">{parts}</span>;
  } else if (live.activeTaskId && !live.activeTaskDone) {
    activity = <span>Manager Agent is routing a task ({eventTime(live.latest!.at, now)})</span>;
  } else {
    activity = <span className="text-muted">All agents are idle. Run a command to see live work here.</span>;
  }

  const isLive = workingAgents.size > 0 || (live.activeTaskId != null && !live.activeTaskDone);

  return (
    <section
      aria-label="Live activity strip"
      className="panel flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5"
    >
      <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-heading">
        <span
          aria-hidden
          className={`inline-block size-2 rounded-full ${
            isLive ? "bg-accent status-working" : "bg-[#5b6371]"
          }`}
        />
        Live
      </span>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Agent activity">
        {chips.map((chip) => (
          <li key={chip.id} className="inline-flex items-center gap-1.5 text-xs">
            <span
              aria-hidden
              className={`inline-block size-1.5 rounded-full ${
                chip.working ? "bg-accent status-working" : "bg-[#5b6371]"
              }`}
            />
            <span className={chip.working ? "font-medium text-accent" : "text-muted"}>
              {AGENT_LABELS[chip.id]}
            </span>
            {chip.working && chip.elapsed && <span className="mono text-[10px] text-muted">{chip.elapsed}</span>}
            <span className="sr-only">{chip.working ? "working" : "idle"}</span>
          </li>
        ))}
      </ul>
      <p aria-live="polite" className="ml-auto text-xs text-body">
        {activity}
      </p>
    </section>
  );
}

/* ------------------------------------------------------ through-glass feed */

function EventRow({ event, now }: { event: OrchestrationEvent; now: number }): ReactNode {
  const t = new Date(event.at);
  const time = Number.isNaN(t.getTime())
    ? ""
    : t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  switch (event.type) {
    case "task.queued": {
      const cmd = typeof event.data.command === "string" ? event.data.command : "";
      return (
        <li className="flex items-start gap-2">
          <TerminalWindow aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" />
          <div className="min-w-0">
            <p className="break-words text-xs leading-relaxed text-heading">{cmd}</p>
            <p className="mono mt-0.5 text-[10px] text-muted">
              task queued · {time} · {event.taskId?.slice(0, 8)}
            </p>
          </div>
        </li>
      );
    }
    case "task.classified":
      return (
        <li className="flex items-start gap-2">
          <Lightning aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" />
          <p className="text-xs leading-relaxed text-body">
            Classified intent <span className="font-semibold text-accent">{String(event.data.intent)}</span> via{" "}
            {event.data.router === "llm" ? "LLM router" : "deterministic fallback router"}
            <span className="mono block text-[10px] text-muted">{time}</span>
          </p>
        </li>
      );
    case "run.started":
      return (
        <li className="flex items-start gap-2">
          <Play aria-hidden className="mt-0.5 size-3.5 shrink-0 text-body" />
          <p className="text-xs text-body">
            {AGENT_LABELS[(event.agentId ?? "research") as AgentId]} Agent run started
            {event.data.refused === true ? " (agent disabled, refusing)" : ""}
            <span className="mono block text-[10px] text-muted">{time}</span>
          </p>
        </li>
      );
    case "tool_call.started": {
      const elapsed = eventTime(event.at, now);
      return (
        <li className="flex items-start gap-2 rounded-[8px] border border-accent/30 bg-accent/5 px-2.5 py-2">
          <CircleNotch aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin text-accent" />
          <p className="min-w-0 text-xs text-body">
            <span className="mono text-accent">{String(event.data.tool)}</span> running
            <span className="mono ml-2 text-[10px] text-muted">{elapsed}</span>
            <span className="mono block truncate text-[10px] text-muted" title={String(event.data.request)}>
              {String(event.data.request)}
            </span>
          </p>
        </li>
      );
    }
    case "tool_call.finished": {
      const ok = event.data.ok === true;
      return (
        <li className="flex items-start gap-2 rounded-[8px] border hairline bg-panel-2 px-2.5 py-2">
          {ok ? (
            <CheckCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ok" />
          ) : (
            <XCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-err" />
          )}
          <p className="min-w-0 text-xs text-body">
            <span className="mono text-heading">{String(event.data.tool)}</span>{" "}
            <span className={ok ? "text-ok" : "text-err"}>{ok ? "ok" : "failed"}</span>
            {event.data.status != null && (
              <span className="mono text-muted"> {String(event.data.status)}</span>
            )}
            <span className="mono text-muted"> in {fmtDuration(Number(event.data.durationMs ?? 0))}</span>
            {typeof event.data.error === "string" && (
              <span className="mono block break-words text-[10px] text-err">{event.data.error}</span>
            )}
            <span className="mono block truncate text-[10px] text-muted" title={String(event.data.request)}>
              {String(event.data.request)}
            </span>
          </p>
        </li>
      );
    }
    case "message.added":
      return (
        <li className="flex items-start gap-2">
          <ChatCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
          <p className="min-w-0 text-xs leading-relaxed text-body">
            <span className="font-medium text-heading">
              {event.data.role === "user" ? "You" : "Manager Agent"}
            </span>{" "}
            {String(event.data.preview ?? "")}
            <span className="mono block text-[10px] text-muted">{time}</span>
          </p>
        </li>
      );
    case "run.completed":
      return (
        <li className="flex items-start gap-2">
          <CheckCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ok" />
          <p className="text-xs text-body">
            Run completed
            {typeof event.data.toolCallCount === "number" && (
              <span className="mono text-muted"> ({event.data.toolCallCount} tool calls)</span>
            )}
            <span className="mono block text-[10px] text-muted">{time}</span>
          </p>
        </li>
      );
    case "run.failed":
      return (
        <li className="flex items-start gap-2">
          <XCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-err" />
          <p className="min-w-0 text-xs text-body">
            Run failed
            {typeof event.data.error === "string" && (
              <span className="block break-words text-err">{event.data.error}</span>
            )}
            <span className="mono block text-[10px] text-muted">{time}</span>
          </p>
        </li>
      );
    case "task.completed":
      return (
        <li className="flex items-start gap-2 rounded-[8px] border border-ok/30 bg-ok/5 px-2.5 py-2">
          <SealCheck aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ok" />
          <p className="text-xs text-body">
            Task completed
            {typeof event.data.resultKind === "string" && event.data.resultKind && (
              <span className="mono text-muted"> · {event.data.resultKind}</span>
            )}
            <span className="mono block text-[10px] text-muted">{time}</span>
          </p>
        </li>
      );
    case "task.failed":
      return (
        <li className="flex items-start gap-2 rounded-[8px] border border-err/30 bg-err/5 px-2.5 py-2">
          <WarningCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-err" />
          <p className="min-w-0 text-xs text-body">
            Task failed
            {typeof event.data.error === "string" && (
              <span className="block break-words text-err">{event.data.error}</span>
            )}
            <span className="mono block text-[10px] text-muted">{time}</span>
          </p>
        </li>
      );
    default:
      return null;
  }
}

const VISIBLE_ROWS = 60;

/**
 * The glass panel: the newest task's real event timeline, growing as the
 * orchestration loop works. Follows the bottom while the reader is at it.
 */
export function LiveGlassPanel({ events, error, ready }: {
  events: OrchestrationEvent[];
  error: string | null;
  ready: boolean;
}) {
  const live = deriveLiveState(events);
  const now = useNow(live.openRuns.length > 0 || (live.activeTaskId != null && !live.activeTaskDone));
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  const rows = live.activeTaskId ? events.filter((e) => e.taskId === live.activeTaskId) : [];
  const visible = rows.slice(Math.max(0, rows.length - VISIBLE_ROWS));

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  return (
    <section aria-labelledby="live-heading" className="panel flex min-h-0 flex-col">
      <h2
        id="live-heading"
        className="flex items-center justify-between gap-2 border-b hairline px-4 py-3 text-sm font-semibold text-heading"
      >
        <span className="flex items-center gap-2">
          <Eye aria-hidden className="size-4 text-accent" />
          Through glass
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide">
          {live.activeTaskId && !live.activeTaskDone ? (
            <>
              <span aria-hidden className="inline-block size-1.5 rounded-full bg-accent status-working" />
              <span className="text-accent">Live</span>
            </>
          ) : (
            <>
              <span aria-hidden className="inline-block size-1.5 rounded-full bg-[#5b6371]" />
              <span className="text-muted">Idle</span>
            </>
          )}
        </span>
      </h2>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        style={{ maxHeight: "420px" }}
      >
        {error ? (
          <div role="alert" className="rounded-[10px] border border-err/40 bg-err/5 px-3 py-2.5 text-xs text-err">
            Live stream error: {error} The dashboard itself still works; rows resume when the
            stream reconnects.
          </div>
        ) : !ready ? (
          <div className="space-y-2" aria-hidden>
            <div className="skeleton h-4 w-3/4 rounded-[6px]" />
            <div className="skeleton h-4 w-1/2 rounded-[6px]" />
            <div className="skeleton h-10 w-full rounded-[8px]" />
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-[10px] border border-dashed hairline px-4 py-8 text-center">
            <p className="text-sm font-semibold text-heading">Nothing has run yet</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              Run a command and watch each real step appear here as it happens: classification,
              tool calls, results. Rows only ever show work that actually happened.
            </p>
          </div>
        ) : (
          <ul aria-live="polite" aria-label="Orchestration events" className="flex flex-col gap-2.5">
            {visible.map((e) => (
              <EventRow key={e.id} event={e} now={now} />
            ))}
          </ul>
        )}
      </div>

      {live.activeTaskCommand && (
        <p className="border-t hairline px-4 py-2.5 text-[11px] leading-relaxed text-muted">
          <span className="mono">task {live.activeTaskId.slice(0, 8)}</span>
          {" · "}
          {live.activeTaskDone
            ? "finished. The full record is on the task page."
            : "running now. Rows appear as the agents really work."}
        </p>
      )}
    </section>
  );
}
