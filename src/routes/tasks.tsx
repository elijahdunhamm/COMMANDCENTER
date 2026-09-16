import { createFileRoute, Link } from "@tanstack/react-router";
import { ListChecks } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { AppHeader, StorageBanner } from "~/components/layout";
import {
  TASK_STATUS_STYLES,
  Skeleton,
  StatusBadge,
  formatDateTime,
} from "~/components/status";
import { fetchTaskHistory } from "~/server/api";
import type { TaskHistoryState } from "~/server/manager";

export const Route = createFileRoute("/tasks")({
  component: TasksPage,
});

function TasksPage() {
  const [state, setState] = useState<TaskHistoryState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchTaskHistory());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main id="main" className="mx-auto max-w-[1100px] px-4 py-8 md:px-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-heading">
          <ListChecks aria-hidden className="size-5 text-accent" />
          Task history
        </h1>
        <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-body">
          Every command the Manager Agent has routed, newest first. Open a task to see its complete
          timeline: classification, agent runs, tool calls, and the final result.
        </p>

        <div className="mt-6">
          <StorageBanner storage={state?.storage} />
          {error && (
            <div role="alert" className="rounded-[10px] border border-err/40 bg-err/5 px-4 py-3 text-sm text-err">
              Could not load the task history: {error}
            </div>
          )}
        </div>

        {!state && !error && (
          <div className="panel mt-6" aria-hidden>
            <div className="divide-y hairline">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="space-y-2 px-4 py-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))}
            </div>
          </div>
        )}

        {state && (
          <section aria-label="All tasks" className="panel mt-6">
            {state.tasks.length === 0 ? (
              <p className="px-4 py-8 text-sm text-muted">
                No tasks yet. Run a command on the Command page and it will appear here.
              </p>
            ) : (
              <>
                <p className="mono border-b hairline px-4 py-2 text-[10px] uppercase tracking-widest text-muted">
                  {state.tasks.length} task{state.tasks.length === 1 ? "" : "s"}, newest first
                </p>
                <ol className="divide-y hairline">
                  {state.tasks.map((task) => (
                    <li key={task.id}>
                      <Link
                        to="/tasks/$taskId"
                        params={{ taskId: task.id }}
                        className="block px-4 py-3 transition-colors hover:bg-panel-2"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <p className="min-w-0 flex-1 text-sm text-body">{task.command}</p>
                          <StatusBadge status={task.status} styles={TASK_STATUS_STYLES} />
                        </div>
                        <p className="mono mt-1.5 text-[10px] text-muted">
                          {formatDateTime(task.createdAt)}
                          {task.intent ? ` · ${task.intent}` : " · unclassified"}
                          {task.router
                            ? task.router === "llm"
                              ? " · LLM router"
                              : " · rules router"
                            : ""}
                          {task.agentId ? ` · ${task.agentId} agent` : ""}
                        </p>
                        {task.error && task.status === "failed" && (
                          <p className="mt-1 text-xs text-err">{task.error}</p>
                        )}
                      </Link>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
