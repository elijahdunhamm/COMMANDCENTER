import { CircleNotch, User } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { formatTime } from "~/components/status";
import { ResultCard } from "~/components/results";
import type { DashboardState } from "~/server/manager";
import type { Message } from "~/server/types";

/**
 * Command chat: the centerpiece. Shows the real persisted feed (user commands
 * + Manager Agent reports) with structured result cards inline. The pending
 * row is a client-side indicator only and clearly labeled as in-progress.
 */

export function MessageRow({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex items-start justify-end gap-2.5">
        <div className="max-w-[85%] rounded-[10px] border hairline bg-panel-2 px-3.5 py-2.5">
          <p className="sr-only">You</p>
          <p className="text-sm leading-relaxed text-heading">{message.content}</p>
          <p className="mono mt-1 text-right text-[10px] text-muted">{formatTime(message.createdAt)}</p>
        </div>
        <span
          aria-hidden
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border hairline bg-panel text-muted"
        >
          <User className="size-3.5" />
        </span>
      </div>
    );
  }
  return (
    <div className="max-w-[92%]">
      <p className="flex items-center gap-2 text-xs font-semibold text-accent">
        Manager Agent
        <span className="mono font-normal text-muted">{formatTime(message.createdAt)}</span>
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-body">{message.content}</p>
    </div>
  );
}

function feedEntries(
  state: DashboardState,
  onSaveTask: (taskId: string) => Promise<string | null>,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  for (const message of state.messages) {
    nodes.push(<MessageRow key={message.id} message={message} />);
    if (message.role === "user" && message.taskId) {
      const result = state.results[message.taskId];
      if (result) {
        nodes.push(
          <ResultCard
            key={`result-${result.id}`}
            payload={result.payload}
            taskId={message.taskId}
            saved={state.savedByTask[message.taskId] ?? null}
            onSaveTask={onSaveTask}
          />,
        );
      }
      const task = state.tasks.find((t) => t.id === message.taskId);
      if (task && task.status === "working") {
        nodes.push(
          <p key={`pending-${task.id}`} className="flex items-center gap-2 text-sm text-muted">
            <CircleNotch aria-hidden className="size-4 animate-spin text-accent" />
            Agent is working on this task. The feed updates as soon as it reports.
          </p>,
        );
      }
    }
  }
  return nodes;
}

export function ChatFeed({ state, pending, onSaveTask }: {
  state: DashboardState;
  pending: boolean;
  onSaveTask: (taskId: string) => Promise<string | null>;
}) {
  const entries = feedEntries(state, onSaveTask);
  return (
    <div aria-live="polite" aria-label="Command feed" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      {entries.length === 0 && !pending ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed hairline px-6 py-16 text-center">
          <h2 className="text-base font-semibold text-heading">No commands yet</h2>
          <p className="max-w-[42ch] text-sm text-muted">
            Type a natural-language task below. The Manager Agent classifies it, routes it to a
            specialist agent, and the structured result appears here with its sources.
          </p>
          <p className="mono text-xs text-muted">
            try: research the Eiffel Tower and where it is located
          </p>
        </div>
      ) : (
        entries
      )}
      {pending && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <CircleNotch aria-hidden className="size-4 animate-spin text-accent" />
          Manager Agent is routing your command. Agents only report real results, so this can take a
          few seconds.
        </p>
      )}
    </div>
  );
}
