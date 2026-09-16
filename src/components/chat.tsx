import {
  ArrowSquareOut,
  CircleNotch,
  MapPin,
  NoteBlank,
  User,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { formatTime } from "~/components/status";
import type { DashboardState } from "~/server/manager";
import type {
  CapabilityMissingResult,
  Message,
  ResearchBriefResult,
  ResultPayload,
} from "~/server/types";

/**
 * Command chat: the centerpiece. Shows the real persisted feed (user commands
 * + Manager Agent reports) with structured result cards inline. The pending
 * row is a client-side indicator only and clearly labeled as in-progress.
 */

function ProvenanceRow({ label, source, url, fetchedAt }: {
  label: string;
  source: string;
  url: string;
  fetchedAt: string;
}) {
  return (
    <p className="mono text-xs text-muted">
      {label}: {source}, fetched {formatTime(fetchedAt)},{" "}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-accent underline underline-offset-4 hover:text-heading"
      >
        view request
        <ArrowSquareOut aria-hidden className="ml-0.5 inline size-3 align-baseline" />
      </a>
    </p>
  );
}

function ResearchResultCard({ payload }: { payload: ResearchBriefResult }) {
  return (
    <div className="panel p-4">
      <h3 className="text-sm font-semibold text-heading">
        Research brief: <span className="mono text-accent">{payload.subject}</span>
      </h3>

      {payload.summary?.text ? (
        <div className="mt-3">
          <p className="text-sm leading-relaxed text-body">{payload.summary.text}</p>
          <div className="mt-2 space-y-1">
            {payload.summary.articleUrl && (
              <p className="text-xs">
                <a
                  href={payload.summary.articleUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline underline-offset-4 hover:text-heading"
                >
                  Read the full Wikipedia article
                  <ArrowSquareOut aria-hidden className="ml-0.5 inline size-3 align-baseline" />
                </a>
              </p>
            )}
            <ProvenanceRow
              label="Summary"
              source={payload.summary.provenance.source}
              url={payload.summary.provenance.url}
              fetchedAt={payload.summary.provenance.fetchedAt}
            />
          </div>
        </div>
      ) : (
        <p className="mt-3 flex items-start gap-2 text-sm text-muted">
          <NoteBlank aria-hidden className="mt-0.5 size-4 shrink-0" />
          No Wikipedia summary could be verified for this subject. Nothing is quoted rather than guessing.
        </p>
      )}

      {payload.place ? (
        <div className="mt-4 border-t hairline pt-3">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-heading">
            <MapPin aria-hidden className="size-3.5 text-accent" />
            Location
          </h4>
          <p className="mt-1.5 text-sm text-body">{payload.place.displayName ?? "Match found"}</p>
          <p className="mono mt-1 text-xs text-muted">
            lat {payload.place.lat?.toFixed(5)}, lon {payload.place.lon?.toFixed(5)}
            {payload.place.category ? `, ${payload.place.category}` : ""}
          </p>
          <div className="mt-2 space-y-1">
            {payload.place.osmUrl && (
              <p className="text-xs">
                <a
                  href={payload.place.osmUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline underline-offset-4 hover:text-heading"
                >
                  View on OpenStreetMap
                  <ArrowSquareOut aria-hidden className="ml-0.5 inline size-3 align-baseline" />
                </a>
              </p>
            )}
            <ProvenanceRow
              label="Geocode"
              source={payload.place.provenance.source}
              url={payload.place.provenance.url}
              fetchedAt={payload.place.provenance.fetchedAt}
            />
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">
          No geocode match was returned for this subject. Non-place topics usually have none.
        </p>
      )}

      {payload.notes.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t hairline pt-3">
          {payload.notes.map((note, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-muted">
              <WarningCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-wait" />
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CapabilityMissingCard({ payload }: { payload: CapabilityMissingResult }) {
  return (
    <div className="rounded-[10px] border border-err/40 bg-err/5 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-err">
        <WarningCircle aria-hidden className="size-4" />
        Capability not implemented
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-body">{payload.message}</p>
    </div>
  );
}

function ResultCard({ payload }: { payload: ResultPayload }) {
  if (payload.kind === "research.brief") return <ResearchResultCard payload={payload} />;
  if (payload.kind === "agent.capability_missing") return <CapabilityMissingCard payload={payload} />;
  return null;
}

function MessageRow({ message }: { message: Message }) {
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

function feedEntries(state: DashboardState): ReactNode[] {
  const nodes: ReactNode[] = [];
  for (const message of state.messages) {
    nodes.push(<MessageRow key={message.id} message={message} />);
    if (message.role === "user" && message.taskId) {
      const result = state.results[message.taskId];
      if (result) {
        nodes.push(<ResultCard key={`result-${result.id}`} payload={result.payload} />);
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

export function ChatFeed({ state, pending }: { state: DashboardState; pending: boolean }) {
  const entries = feedEntries(state);
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
