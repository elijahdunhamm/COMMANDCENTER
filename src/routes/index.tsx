import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight, CircleNotch, TerminalWindow } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { ChatFeed } from "~/components/chat";
import { AppHeader, StorageBanner } from "~/components/layout";
import { LiveGlassPanel, LiveStrip } from "~/components/live";
import { AgentsPanel, AgentsPanelSkeleton, TasksPanel, TasksPanelSkeleton } from "~/components/panels";
import { useEventStream } from "~/hooks/useEventStream";
import { fetchDashboardState, saveResultToLibrary, submitCommand } from "~/server/api";
import type { DashboardState } from "~/server/manager";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

const POLL_MS = 4000;

function Dashboard() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stream = useEventStream();

  const refresh = useCallback(async () => {
    try {
      const next = await fetchDashboardState();
      setState(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // When the stream reports a task really finished, refresh immediately so
  // the chat, agents panel, and history flip without waiting for the poll.
  const lastHandledSeq = useRef(0);
  useEffect(() => {
    const fresh = stream.events.filter((e) => e.seq > lastHandledSeq.current);
    if (fresh.length === 0) return;
    lastHandledSeq.current = fresh[fresh.length - 1].seq;
    if (fresh.some((e) => e.type === "task.completed" || e.type === "task.failed")) {
      void refresh();
    }
  }, [stream.events, refresh]);

  /** Saves a research result for real, then refreshes from the store. Returns
   *  an error message for the inline alert, or null on success. */
  const handleSaveTask = useCallback(
    async (taskId: string): Promise<string | null> => {
      try {
        const res = await saveResultToLibrary({ data: { taskId } });
        await refresh();
        if (!res.ok) return res.error ?? "The result could not be saved.";
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [refresh],
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = command.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setSubmitError(null);
    try {
      const res = await submitCommand({ data: { command: trimmed } });
      if (!res.ok) {
        setSubmitError(res.error ?? "The command could not be executed.");
      } else {
        setCommand("");
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
      inputRef.current?.focus();
      void refresh();
    }
  }

  const storage = state?.storage;

  return (
    <div className="min-h-dvh">
      <AppHeader />

      <main id="main" className="mx-auto max-w-[1400px] px-4 py-6 md:px-6">
        <StorageBanner storage={storage} />

        <LiveStrip events={stream.events} error={stream.error} />

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section aria-labelledby="feed-heading" className="panel flex min-h-[70dvh] flex-col lg:h-[calc(100dvh-7.5rem)]">
            <h2
              id="feed-heading"
              className="flex items-center gap-2 border-b hairline px-4 py-3 text-sm font-semibold text-heading"
            >
              <TerminalWindow aria-hidden className="size-4 text-accent" />
              Command feed
            </h2>

            <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
              {loadError ? (
                <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
                  <p className="text-sm text-err">Could not load the dashboard state: {loadError}</p>
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="rounded-[10px] border hairline bg-panel-2 px-4 py-2 text-sm text-heading hover:border-accent"
                  >
                    Retry
                  </button>
                </div>
              ) : state ? (
                <ChatFeed state={state} pending={pending} onSaveTask={handleSaveTask} />
              ) : (
                <div className="flex flex-1 flex-col gap-4" aria-hidden>
                  <div className="self-end skeleton h-12 w-2/3 rounded-[10px]" />
                  <div className="skeleton h-8 w-1/2" />
                  <div className="skeleton h-24 w-3/4 rounded-[10px]" />
                </div>
              )}
            </div>

            <form onSubmit={(e) => void onSubmit(e)} className="border-t hairline px-4 py-4">
              <label htmlFor="command-input" className="block text-xs font-medium text-heading">
                Command
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id="command-input"
                  ref={inputRef}
                  name="command"
                  autoComplete="off"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="e.g. Research the Eiffel Tower and where it is located"
                  className="min-w-0 flex-1 rounded-[10px] border hairline bg-panel-2 px-3 py-2.5 text-sm text-heading placeholder:text-muted"
                />
                <button
                  type="submit"
                  disabled={pending || command.trim().length === 0}
                  className="inline-flex items-center gap-1.5 rounded-[10px] bg-accent px-4 py-2.5 text-sm font-semibold text-ink transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {pending ? (
                    <CircleNotch aria-hidden className="size-4 animate-spin" />
                  ) : (
                    <ArrowRight aria-hidden className="size-4" />
                  )}
                  {pending ? "Routing" : "Run"}
                </button>
              </div>
              {submitError && (
                <p role="alert" className="mt-2 text-sm text-err">
                  {submitError}
                </p>
              )}
              <p className="mt-2 text-xs text-muted">
                Research commands run for real against Wikipedia and OpenStreetMap. Coding,
                Opportunity, and DealFinder agents are registered but not implemented, and they will
                say so instead of producing fake results.
              </p>
            </form>
          </section>

          <div className="flex flex-col gap-6">
            <LiveGlassPanel events={stream.events} error={stream.error} ready={stream.ready} />
            {state ? <AgentsPanel state={state} /> : <AgentsPanelSkeleton />}
            {state ? <TasksPanel state={state} /> : <TasksPanelSkeleton />}
          </div>
        </div>
      </main>
    </div>
  );
}
