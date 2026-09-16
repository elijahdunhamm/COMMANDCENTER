import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, CircleNotch, TerminalWindow } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { ChatFeed } from "~/components/chat";
import { AgentsPanel, AgentsPanelSkeleton, TasksPanel, TasksPanelSkeleton } from "~/components/panels";
import { fetchDashboardState, submitCommand } from "~/server/api";
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
      <header className="sticky top-0 z-40 border-b hairline bg-ink/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between gap-4 px-4 md:px-6">
          <p className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight text-heading">
              DealFinder Command Center
            </span>
            <span className="mono hidden text-[10px] uppercase tracking-widest text-muted sm:inline">
              personal agent ops
            </span>
          </p>
          <nav aria-label="Primary" className="flex items-center gap-1">
            <Link
              to="/"
              className="rounded-full px-3 py-1.5 text-sm text-body hover:bg-panel hover:text-heading"
              activeProps={{ className: "bg-panel text-heading font-medium" }}
            >
              Command
            </Link>
            <Link
              to="/settings"
              className="rounded-full px-3 py-1.5 text-sm text-body hover:bg-panel hover:text-heading"
              activeProps={{ className: "bg-panel text-heading font-medium" }}
            >
              Settings
            </Link>
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-[1400px] px-4 py-6 md:px-6">
        {storage && !storage.ok && (
          <div role="alert" className="mb-4 rounded-[10px] border border-err/40 bg-err/5 px-4 py-3 text-sm text-err">
            Storage error: {storage.error} Tasks and results cannot be saved until this is resolved.
          </div>
        )}
        {storage && storage.ok && storage.mode === "ephemeral" && (
          <p className="mb-4 rounded-[10px] border border-accent/40 bg-accent/5 px-4 py-3 text-sm text-body">
            <span className="font-medium text-accent">Ephemeral mode:</span> data is not persisted.
            Set DATABASE_URL to switch this dashboard to Postgres. Everything else works the same.
          </p>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
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
                <ChatFeed state={state} pending={pending} />
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
            {state ? <AgentsPanel state={state} /> : <AgentsPanelSkeleton />}
            {state ? <TasksPanel state={state} /> : <TasksPanelSkeleton />}
          </div>
        </div>
      </main>
    </div>
  );
}
