import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ClipboardText } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { MessageRow } from "~/components/chat";
import { AppHeader, StorageBanner } from "~/components/layout";
import { ResultCard } from "~/components/results";
import {
  TASK_STATUS_STYLES,
  Skeleton,
  StatusBadge,
  formatDateTime,
  runDuration,
} from "~/components/status";
import { fetchTaskDetail, saveResultToLibrary } from "~/server/api";
import type { TaskDetailResponse } from "~/server/manager";
import type { AgentRun, ToolCall } from "~/server/types";

export const Route = createFileRoute("/tasks/$taskId")({
  component: TaskDetailPage,
});

function ToolCallRow({ call }: { call: ToolCall }) {
  return (
    <li className="border-l-2 border-hairline pl-3">
      <p className="mono text-xs">
        <span className={call.ok ? "text-ok" : "text-err"}>{call.tool}</span>{" "}
        <span className="text-muted">
          {call.ok
            ? `HTTP ${call.status}`
            : call.status != null
              ? `failed, HTTP ${call.status}`
              : call.error
                ? `failed: ${call.error}`
                : "failed"}
          {`, ${call.durationMs}ms`}
        </span>
      </p>
      <a
        href={call.request}
        target="_blank"
        rel="noreferrer"
        className="mono mt-0.5 block break-all text-[11px] text-accent underline underline-offset-4 hover:text-heading"
      >
        {call.request}
      </a>
    </li>
  );
}

function RunBlock({ run }: { run: AgentRun }) {
  const duration = runDuration(run);
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-heading">
          Run: <span className="mono text-accent">{run.agentId}</span> agent
        </h3>
        <StatusBadge status={run.status} styles={TASK_STATUS_STYLES} />
      </div>
      <p className="mono mt-1 text-[10px] text-muted">
        started {formatDateTime(run.startedAt)}
        {run.finishedAt
          ? `, finished ${formatDateTime(run.finishedAt)}`
          : ", no finish recorded (run still open or process died mid-run)"}
        {duration != null ? `, ${duration.toFixed(1)}s wall clock` : ""}
      </p>
      {run.error && <p className="mt-2 text-xs text-err">{run.error}</p>}
      <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide text-heading">
        Tool calls
      </h4>
      {run.toolCalls.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted">No tool calls were made.</p>
      ) : (
        <ul className="mt-1.5 space-y-2">
          {run.toolCalls.map((call, i) => (
            <ToolCallRow key={i} call={call} />
          ))}
        </ul>
      )}
    </div>
  );
}

type Detail = NonNullable<TaskDetailResponse["detail"]>;

/** Merged timeline: messages, run blocks, and the result, in real time order. */
function buildTimeline(
  resp: Detail,
  saved: Detail["saved"],
  onSaveTask: (taskId: string) => Promise<string | null>,
): ReactNode[] {
  const events: { at: string; node: ReactNode }[] = [];

  for (const message of resp.messages) {
    events.push({ at: message.createdAt, node: <MessageRow message={message} /> });
  }
  for (const run of resp.runs) {
    events.push({ at: run.startedAt, node: <RunBlock run={run} /> });
  }
  if (resp.result) {
    events.push({
      at: resp.result.createdAt,
      node: (
        <ResultCard
          payload={resp.result.payload}
          taskId={resp.result.taskId}
          saved={saved}
          onSaveTask={onSaveTask}
        />
      ),
    });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return events.map((e, i) => <div key={i}>{e.node}</div>);
}

function TaskDetailPage() {
  const { taskId } = Route.useParams();
  const [resp, setResp] = useState<TaskDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setResp(await fetchTaskDetail({ data: { taskId } }));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSaveTask = useCallback(
    async (id: string): Promise<string | null> => {
      try {
        const res = await saveResultToLibrary({ data: { taskId: id } });
        await refresh();
        if (!res.ok) return res.error ?? "The result could not be saved.";
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [refresh],
  );

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main id="main" className="mx-auto max-w-[900px] px-4 py-8 md:px-6">
        <Link
          to="/tasks"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-heading"
        >
          <ArrowLeft aria-hidden className="size-4" />
          All tasks
        </Link>

        {resp && <StorageBanner storage={resp.storage} />}

        {loadError && (
          <div role="alert" className="mt-6 rounded-[10px] border border-err/40 bg-err/5 px-4 py-3 text-sm text-err">
            Could not load this task: {loadError}
            <button
              type="button"
              onClick={() => void refresh()}
              className="ml-3 rounded-[10px] border hairline bg-panel-2 px-3 py-1 text-xs text-heading hover:border-accent"
            >
              Retry
            </button>
          </div>
        )}

        {!resp && !loadError && (
          <div className="mt-6 space-y-3" aria-hidden>
            <Skeleton className="h-6 w-2/3" />
            <div className="skeleton h-32 w-full rounded-[10px]" />
            <div className="skeleton h-24 w-full rounded-[10px]" />
          </div>
        )}

        {resp && !resp.ok && (
          <div role="alert" className="mt-6 rounded-[10px] border border-err/40 bg-err/5 px-4 py-3 text-sm text-err">
            Storage error: {resp.error} The task record cannot be read until this is resolved.
          </div>
        )}

        {resp && resp.ok && !resp.detail && (
          <div className="panel mt-6 p-8 text-center">
            <h1 className="text-base font-semibold text-heading">Task not found</h1>
            <p className="mt-2 text-sm text-muted">
              No task with this id exists in the current store. In ephemeral mode, tasks disappear
              when the process restarts.
            </p>
          </div>
        )}

        {resp && resp.ok && resp.detail && (
          <>
            <h1 className="mt-4 flex items-start gap-2 text-lg font-semibold leading-snug tracking-tight text-heading">
              <ClipboardText aria-hidden className="mt-1 size-5 shrink-0 text-accent" />
              <span className="min-w-0 break-words">{resp.detail.task.command}</span>
            </h1>

            <div className="mono mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
              <StatusBadge status={resp.detail.task.status} styles={TASK_STATUS_STYLES} />
              <span>task {resp.detail.task.id.slice(0, 8)}</span>
              <span>{resp.detail.task.intent ? `intent: ${resp.detail.task.intent}` : "intent: unclassified"}</span>
              <span>
                router:{" "}
                {resp.detail.task.router === "llm"
                  ? "LLM"
                  : resp.detail.task.router === "fallback"
                    ? "deterministic rules"
                    : "not recorded"}
              </span>
              <span>
                agent: {resp.detail.task.agentId ?? "none"}
              </span>
              <span>created {formatDateTime(resp.detail.task.createdAt)}</span>
            </div>
            {resp.detail.task.error && resp.detail.task.status === "failed" && (
              <p className="mt-3 rounded-[10px] border border-err/40 bg-err/5 px-4 py-3 text-sm text-err">
                {resp.detail.task.error}
              </p>
            )}

            <h2 className="mt-8 border-b hairline pb-2 text-sm font-semibold text-heading">
              Timeline
            </h2>
            <div className="mt-4 flex flex-col gap-4">
              {buildTimeline(resp.detail, resp.detail.saved, handleSaveTask)}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
