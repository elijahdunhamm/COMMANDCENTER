import { Cpu, ListChecks } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { AGENT_STATUS_STYLES, TASK_STATUS_STYLES, Skeleton, StatusBadge, formatTime } from "~/components/status";
import type { DashboardState } from "~/server/manager";

/** Agents panel: registry entries with live statuses derived from real runs. */

export function AgentsPanel({ state }: { state: DashboardState }) {
  return (
    <section aria-labelledby="agents-heading" className="panel">
      <h2
        id="agents-heading"
        className="flex items-center gap-2 border-b hairline px-4 py-3 text-sm font-semibold text-heading"
      >
        <Cpu aria-hidden className="size-4 text-accent" />
        Agents
      </h2>
      <ul className="divide-y hairline">
        {state.agents.map((agent) => (
          <li key={agent.id} className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-heading">{agent.name}</h3>
              <StatusBadge status={agent.status} styles={AGENT_STATUS_STYLES} />
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{agent.description}</p>
            {agent.capability === "awaiting" && (
              <p className="mt-1 text-xs text-wait">
                Registered, not implemented. It declines tasks honestly instead of inventing output.
              </p>
            )}
            {agent.capabilities.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {agent.capabilities.map((c) => (
                  <li key={c} className="text-xs text-muted">
                    {c}
                  </li>
                ))}
              </ul>
            )}
            {agent.lastRunAt && (
              <p className="mono mt-1.5 text-[10px] text-muted">
                last run {formatTime(agent.lastRunAt)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgentsPanelSkeleton() {
  return (
    <section className="panel" aria-hidden>
      <div className="border-b hairline px-4 py-3">
        <Skeleton className="h-4 w-20" />
      </div>
      <ul className="divide-y hairline">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="space-y-2 px-4 py-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-14" />
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Task history: newest first, real statuses only. */

export function TasksPanel({ state }: { state: DashboardState }) {
  return (
    <section aria-labelledby="tasks-heading" className="panel">
      <h2
        id="tasks-heading"
        className="flex items-center gap-2 border-b hairline px-4 py-3 text-sm font-semibold text-heading"
      >
        <ListChecks aria-hidden className="size-4 text-accent" />
        Task history
      </h2>
      {state.tasks.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">
          No tasks yet. The first command you run will appear here with its status and duration.
        </p>
      ) : (
        <ol className="divide-y hairline">
          {state.tasks.map((task) => {
            const run = state.runs[task.id]?.[0];
            const duration =
              run?.finishedAt && run
                ? Math.max(
                    0,
                    Math.round(
                      (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 100,
                    ) / 10,
                  )
                : null;
            return (
              <li key={task.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="line-clamp-2 text-sm text-body">{task.command}</p>
                  <StatusBadge status={task.status} styles={TASK_STATUS_STYLES} />
                </div>
                <p className="mono mt-1.5 text-[10px] text-muted">
                  {task.intent ? `${task.intent}` : "unclassified"}
                  {task.router ? `, ${task.router === "llm" ? "LLM router" : "rules router"}` : ""}
                  {task.agentId ? `, ${task.agentId} agent` : ""}
                  {duration != null ? `, ${duration.toFixed(1)}s` : ""}
                  {`, ${formatTime(task.createdAt)}`}
                </p>
                {task.error && task.status === "failed" && (
                  <p className="mt-1 text-xs text-err">{task.error}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function TasksPanelSkeleton() {
  return (
    <section className="panel" aria-hidden>
      <div className="border-b hairline px-4 py-3">
        <Skeleton className="h-4 w-24" />
      </div>
      <ul className="divide-y hairline">
        {[0, 1].map((i) => (
          <li key={i} className="space-y-2 px-4 py-3">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3 w-1/2" />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PanelSkeletonRow(): ReactNode {
  return <Skeleton className="h-4 w-full" />;
}
