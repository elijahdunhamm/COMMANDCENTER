import type { AgentStatus, TaskStatus } from "~/server/types";

/**
 * Status presentation. Dots appear ONLY on real semantic state (agent/task
 * status), per the design skill's dot rule. Text always accompanies color.
 */

export const AGENT_STATUS_STYLES: Record<AgentStatus, { dot: string; text: string; label: string }> = {
  idle: { dot: "bg-[#5b6371]", text: "text-muted", label: "idle" },
  working: { dot: "bg-accent status-working", text: "text-accent", label: "working" },
  waiting: { dot: "bg-wait", text: "text-wait", label: "waiting" },
  completed: { dot: "bg-ok", text: "text-ok", label: "completed" },
  failed: { dot: "bg-err", text: "text-err", label: "failed" },
  disabled: { dot: "bg-[#5b6371]", text: "text-muted", label: "disabled" },
};

export const TASK_STATUS_STYLES: Record<TaskStatus, { dot: string; text: string; label: string }> = {
  queued: { dot: "bg-[#5b6371]", text: "text-muted", label: "queued" },
  working: { dot: "bg-accent status-working", text: "text-accent", label: "working" },
  completed: { dot: "bg-ok", text: "text-ok", label: "completed" },
  failed: { dot: "bg-err", text: "text-err", label: "failed" },
};

export function StatusBadge({
  status,
  styles,
}: {
  status: AgentStatus | TaskStatus;
  styles: Record<string, { dot: string; text: string; label: string }>;
}) {
  const s = styles[status] ?? styles.idle;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`inline-block size-1.5 rounded-full ${s.dot}`} />
      <span className={`text-xs font-medium ${s.text}`}>{s.label}</span>
    </span>
  );
}

export function Skeleton({ className }: { className: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

export function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Wall-clock duration of a run, in seconds; null while still running. */
export function runDuration(run: { startedAt: string; finishedAt: string | null } | undefined) {
  if (!run?.finishedAt) return null;
  return Math.max(
    0,
    Math.round(
      (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 100,
    ) / 10,
  );
}
