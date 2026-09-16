import { createFileRoute, Link } from "@tanstack/react-router";
import { BookmarkSimple, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { AppHeader, StorageBanner } from "~/components/layout";
import { ResearchResultCard } from "~/components/results";
import { formatDateTime } from "~/components/status";
import { deleteSavedResearch, fetchSavedLibrary } from "~/server/api";
import type { SavedLibraryState } from "~/server/manager";

export const Route = createFileRoute("/saved")({
  component: SavedPage,
});

function SavedItem({ item, onDeleted }: {
  item: SavedLibraryState["items"][number];
  onDeleted: () => void;
}) {
  // Two-step confirm: the first click asks, the second click really deletes.
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onDelete() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    deleteSavedResearch({ data: { id: item.id } })
      .then((res) => {
        if (!res.ok) {
          setError(res.error ?? "The item could not be deleted.");
          setConfirming(false);
        } else {
          onDeleted();
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setConfirming(false);
      })
      .finally(() => setBusy(false));
  }

  return (
    <li className="p-4">
      <div className="mono flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <BookmarkSimple aria-hidden className="size-3.5 text-accent" weight="fill" />
          saved {formatDateTime(item.createdAt)}
        </span>
        <span>agent: {item.agentId}</span>
        <Link
          to="/tasks/$taskId"
          params={{ taskId: item.taskId }}
          className="text-accent underline underline-offset-4 hover:text-heading"
        >
          originating task
        </Link>
      </div>

      <div className="panel mt-3 p-4">
        {item.payload.kind === "research.brief" ? (
          <ResearchResultCard payload={item.payload} />
        ) : (
          <p className="text-sm text-muted">
            This saved item is of kind <span className="mono">{item.payload.kind}</span>, which has
            no dedicated view. Its raw payload is preserved.
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className={
            confirming
              ? "inline-flex items-center gap-1.5 rounded-[10px] border border-err/40 bg-err/10 px-3 py-1.5 text-xs font-medium text-err transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              : "inline-flex items-center gap-1.5 rounded-[10px] border hairline bg-panel-2 px-3 py-1.5 text-xs font-medium text-body transition-transform hover:border-err/40 hover:text-err active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          }
        >
          <Trash aria-hidden className="size-3.5" />
          {confirming ? "Confirm delete" : busy ? "Deleting" : "Delete"}
        </button>
        {confirming && !busy && (
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-xs text-muted underline underline-offset-4 hover:text-heading"
          >
            Keep it
          </button>
        )}
        {error && (
          <p role="alert" className="text-xs text-err">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}

function SavedPage() {
  const [state, setState] = useState<SavedLibraryState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchSavedLibrary());
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
      <main id="main" className="mx-auto max-w-[900px] px-4 py-8 md:px-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-heading">
          <BookmarkSimple aria-hidden className="size-5 text-accent" />
          Saved research
        </h1>
        <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-body">
          Research results you explicitly saved. Each item keeps a copy of the payload and its
          provenance exactly as fetched; deleting the original task does not change it.
        </p>

        <div className="mt-6">
          <StorageBanner storage={state?.storage} />
          {error && (
            <div role="alert" className="rounded-[10px] border border-err/40 bg-err/5 px-4 py-3 text-sm text-err">
              Could not load the library: {error}
            </div>
          )}
        </div>

        {!state && !error && (
          <div className="mt-6 space-y-3" aria-hidden>
            <div className="skeleton h-24 w-full rounded-[10px]" />
            <div className="skeleton h-24 w-full rounded-[10px]" />
          </div>
        )}

        {state && state.items.length === 0 && (
          <div className="panel mt-6 p-8 text-center">
            <h2 className="text-base font-semibold text-heading">Nothing saved yet</h2>
            <p className="mx-auto mt-2 max-w-[52ch] text-sm text-muted">
              Run a research command, then choose Save to library on its result. Saved items appear
              here with their sources.
            </p>
          </div>
        )}

        {state && state.items.length > 0 && (
          <ul className="panel mt-6 divide-y hairline">
            {state.items.map((item) => (
              <SavedItem key={item.id} item={item} onDeleted={() => void refresh()} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
