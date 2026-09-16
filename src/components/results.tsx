import { ArrowSquareOut, BookmarkSimple, MapPin, NoteBlank, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { formatTime } from "~/components/status";
import type {
  CapabilityMissingResult,
  DisabledAgentResult,
  ResearchBriefResult,
  ResultPayload,
  SavedRecord,
} from "~/server/types";

/**
 * Structured result cards, shared by the command feed, the task detail page,
 * and the saved-research library. Every externally-sourced value shows its
 * provenance; every card is honest about what could not be verified.
 */

export function ProvenanceRow({ label, source, url, fetchedAt }: {
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

export function ResearchResultCard({ payload }: { payload: ResearchBriefResult }) {
  return (
    <div>
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

export function CapabilityMissingCard({ payload }: { payload: CapabilityMissingResult }) {
  return (
    <div>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-err">
        <WarningCircle aria-hidden className="size-4" />
        Capability not implemented
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-body">{payload.message}</p>
    </div>
  );
}

export function DisabledAgentCard({ payload }: { payload: DisabledAgentResult }) {
  return (
    <div>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-err">
        <WarningCircle aria-hidden className="size-4" />
        Task refused: agent disabled
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-body">{payload.message}</p>
    </div>
  );
}

/**
 * The save control shown on savable results. `onSaveTask` returns an error
 * message or null; the record itself is never optimistic, the parent refreshes
 * from the store and `saved` reflects what really persisted.
 */
function SaveRow({ taskId, saved, onSaveTask }: {
  taskId: string;
  saved?: SavedRecord | null;
  onSaveTask: (taskId: string) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (saved) {
    return (
      <p className="mt-3 flex flex-wrap items-center gap-2 border-t hairline pt-3 text-xs text-muted">
        <BookmarkSimple aria-hidden className="size-3.5 text-accent" weight="fill" />
        Saved to your library.
        <Link to="/saved" className="text-accent underline underline-offset-4 hover:text-heading">
          Open library
        </Link>
      </p>
    );
  }

  return (
    <div className="mt-3 border-t hairline pt-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          onSaveTask(taskId)
            .then((err) => setError(err))
            .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false));
        }}
        className="inline-flex items-center gap-1.5 rounded-[10px] border hairline bg-panel-2 px-3 py-1.5 text-xs font-medium text-heading transition-transform hover:border-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <BookmarkSimple aria-hidden className="size-3.5 text-accent" />
        {busy ? "Saving" : "Save to library"}
      </button>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-err">
          {error}
        </p>
      )}
    </div>
  );
}

export function ResultCard({ payload, taskId, saved, onSaveTask }: {
  payload: ResultPayload;
  taskId?: string;
  saved?: SavedRecord | null;
  onSaveTask?: (taskId: string) => Promise<string | null>;
}) {
  if (payload.kind === "research.brief") {
    return (
      <div className="panel p-4">
        <ResearchResultCard payload={payload} />
        {taskId && onSaveTask && (
          <SaveRow taskId={taskId} saved={saved} onSaveTask={onSaveTask} />
        )}
      </div>
    );
  }
  if (payload.kind === "agent.capability_missing") {
    return (
      <div className="rounded-[10px] border border-err/40 bg-err/5 p-4">
        <CapabilityMissingCard payload={payload} />
      </div>
    );
  }
  if (payload.kind === "agent.disabled") {
    return (
      <div className="rounded-[10px] border border-err/40 bg-err/5 p-4">
        <DisabledAgentCard payload={payload} />
      </div>
    );
  }
  return null;
}
