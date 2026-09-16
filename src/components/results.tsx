import { ArrowSquareOut, BookmarkSimple, Clock, GlobeSimple, MapPin, NoteBlank, Phone, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { formatTime } from "~/components/status";
import type {
  CapabilityMissingResult,
  DealFinderHit,
  DealFinderSearchResult,
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

/** "not listed" is the honest rendering for fields OpenStreetMap does not carry. */
function NotListed() {
  return <span className="text-muted/70 italic">not listed</span>;
}

function DealFinderHitRow({ hit }: { hit: DealFinderHit }) {
  return (
    <li className="py-3.5 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        {hit.name ? (
          <p className="text-sm font-semibold text-heading">{hit.name}</p>
        ) : (
          <p className="text-sm font-semibold text-heading/60 italic">Name not listed</p>
        )}
        <p className="mono shrink-0 text-xs text-accent" title="Computed straight-line distance from the search point">
          {hit.distanceMiles.toFixed(1)} mi
        </p>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="mono text-[11px] text-muted">{hit.category}</span>
        <span className="mono rounded-[6px] border hairline bg-panel-2 px-1.5 py-0.5 text-[11px] text-wait">
          price {hit.price.display}
        </span>
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-muted">{hit.why}</p>

      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex items-start gap-1.5">
          <dt className="flex items-center gap-1 text-muted">
            <MapPin aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">Address</span>
          </dt>
          <dd className="text-body">{hit.address ?? <NotListed />}</dd>
        </div>
        <div className="flex items-start gap-1.5">
          <dt className="flex items-center gap-1 text-muted">
            <Phone aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">Phone</span>
          </dt>
          <dd className="text-body">
            {hit.phone ?? <NotListed />}
          </dd>
        </div>
        <div className="flex items-start gap-1.5">
          <dt className="flex items-center gap-1 text-muted">
            <GlobeSimple aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">Website</span>
          </dt>
          <dd>
            {hit.website ? (
              <a
                href={hit.website}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline underline-offset-4 hover:text-heading"
              >
                {hit.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                <ArrowSquareOut aria-hidden className="ml-0.5 inline size-3 align-baseline" />
              </a>
            ) : (
              <span className="text-body">
                <NotListed />
              </span>
            )}
          </dd>
        </div>
        <div className="flex items-start gap-1.5">
          <dt className="flex items-center gap-1 text-muted">
            <Clock aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">Opening hours</span>
          </dt>
          <dd className="text-body">{hit.openingHours ?? <NotListed />}</dd>
        </div>
      </dl>

      <p className="mt-1.5 text-xs">
        <a
          href={hit.osmUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline underline-offset-4 hover:text-heading"
        >
          View on OpenStreetMap
          <ArrowSquareOut aria-hidden className="ml-0.5 inline size-3 align-baseline" />
        </a>
      </p>
    </li>
  );
}

export function DealFinderResultCard({ payload }: { payload: DealFinderSearchResult }) {
  const serviceLabel = payload.service ? payload.service.label : "local service";
  const radiusLabel = `${Number(payload.radiusMiles.toFixed(payload.radiusMiles % 1 === 0 ? 0 : 1))} mile radius`;

  return (
    <div>
      <h3 className="text-sm font-semibold text-heading">
        Local search: <span className="mono text-accent">{serviceLabel}</span>
        {payload.origin ? (
          <>
            {" "}near <span className="mono text-accent">{payload.origin.label}</span>
          </>
        ) : null}
      </h3>

      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
        <span className="mono rounded-[6px] border hairline bg-panel-2 px-1.5 py-0.5 text-muted">
          {radiusLabel}
          {payload.radiusSource === "default" ? " (default)" : ""}
        </span>
        {payload.maxPrice && (
          <span className="mono rounded-[6px] border hairline bg-panel-2 px-1.5 py-0.5 text-muted">
            under ${payload.maxPrice.amount} (unapplied: prices unverifiable)
          </span>
        )}
        {payload.specialties.length > 0 && (
          <span className="mono rounded-[6px] border hairline bg-panel-2 px-1.5 py-0.5 text-wait">
            specialty "{payload.specialties.join('", "')}" captured, not searchable
          </span>
        )}
        {payload.servedFromCache && (
          <span className="mono rounded-[6px] border hairline bg-panel-2 px-1.5 py-0.5 text-muted">
            identical query served from in-process cache
          </span>
        )}
      </div>

      {payload.askedForLocation ? (
        <p className="mt-3 flex items-start gap-2 rounded-[10px] border hairline bg-panel-2 p-3 text-sm leading-relaxed text-body">
          <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-wait" />
          <span>
            No location could be resolved from this command, so no search area was guessed.
            Provide a place name (e.g. "near downtown Austin") or coordinates
            (e.g. "near 30.2672, -97.7431") and run the command again.
          </span>
        </p>
      ) : payload.sourceUnavailable ? (
        <div className="mt-3 rounded-[10px] border border-err/40 bg-err/5 p-3">
          <p className="flex items-start gap-2 text-sm leading-relaxed text-body">
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-err" />
            <span>
              Search source unavailable. The OpenStreetMap Overpass request did not return
              usable data after a retry, so no results could be fetched. Nothing was invented
              to fill the gap; the exact request is linked below.
            </span>
          </p>
          {payload.overpassUrl && (
            <p className="mono mt-2 text-xs text-muted">
              Attempted request:{" "}
              <a
                href={payload.overpassUrl}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline underline-offset-4 hover:text-heading"
              >
                view request
                <ArrowSquareOut aria-hidden className="ml-0.5 inline size-3 align-baseline" />
              </a>
            </p>
          )}
        </div>
      ) : payload.results.length === 0 ? (
        <p className="mt-3 flex items-start gap-2 text-sm leading-relaxed text-muted">
          <NoteBlank aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            No matches were found in OpenStreetMap data for this area and radius. Coverage
            varies by area; that is a property of the map data, not a filtered opinion.
          </span>
        </p>
      ) : (
        <div className="mt-3">
          <p className="text-xs text-muted">
            {payload.results.length} match{payload.results.length === 1 ? "" : "es"}, ranked by
            computed distance from the search point.
          </p>
          <ul className="mt-1 divide-y hairline">
            {payload.results.map((hit) => (
              <DealFinderHitRow key={`${hit.osmType}-${hit.osmId}`} hit={hit} />
            ))}
          </ul>
          {payload.overpassUrl && (
            <div className="mt-3 border-t hairline pt-2">
              <ProvenanceRow
                label="All results"
                source="OpenStreetMap via Overpass API"
                url={payload.overpassUrl}
                fetchedAt={payload.results[0]?.provenance.fetchedAt ?? new Date().toISOString()}
              />
            </div>
          )}
        </div>
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
  if (payload.kind === "dealfinder.search") {
    return (
      <div className="panel p-4">
        <DealFinderResultCard payload={payload} />
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
