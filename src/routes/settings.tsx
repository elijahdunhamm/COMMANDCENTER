import { createFileRoute, Link } from "@tanstack/react-router";
import { Gear, Lightbulb, Plugs } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { fetchDashboardState } from "~/server/api";
import type { DashboardState } from "~/server/manager";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

function Settings() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchDashboardState());
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
      <header className="sticky top-0 z-40 border-b hairline bg-ink/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between gap-4 px-4 md:px-6">
          <p className="text-sm font-semibold tracking-tight text-heading">
            DealFinder Command Center
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

      <main id="main" className="mx-auto max-w-[860px] px-4 py-8 md:px-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-heading">
          <Gear aria-hidden className="size-5 text-accent" />
          Settings
        </h1>
        <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-body">
          This page reports real configuration only. Values are never displayed, only whether each
          variable is present. Everything the dashboard does is derived from these.
        </p>

        {error && (
          <p role="alert" className="mt-6 rounded-[10px] border border-err/40 bg-err/5 px-4 py-3 text-sm text-err">
            Could not load settings: {error}
          </p>
        )}

        {!state && !error && (
          <div className="mt-6 space-y-3" aria-hidden>
            <div className="skeleton h-16 w-full rounded-[10px]" />
            <div className="skeleton h-16 w-full rounded-[10px]" />
            <div className="skeleton h-16 w-3/4 rounded-[10px]" />
          </div>
        )}

        {state && (
          <div className="mt-8 space-y-6">
            <section aria-labelledby="env-heading" className="panel">
              <h2 id="env-heading" className="border-b hairline px-4 py-3 text-sm font-semibold text-heading">
                Environment variables
              </h2>
              <ul className="divide-y hairline">
                {state.env.vars.map((v) => (
                  <li key={v.name} className="flex items-start justify-between gap-4 px-4 py-3">
                    <div>
                      <p className="mono text-sm text-heading">{v.name}</p>
                      <p className="mt-0.5 max-w-[52ch] text-xs leading-relaxed text-muted">{v.purpose}</p>
                    </div>
                    {v.set ? (
                      <span className="shrink-0 rounded-full border border-ok/40 bg-ok/10 px-2.5 py-0.5 text-xs font-medium text-ok">
                        set
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-full border hairline bg-panel-2 px-2.5 py-0.5 text-xs font-medium text-muted">
                        missing
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="storage-heading" className="panel">
              <h2 id="storage-heading" className="border-b hairline px-4 py-3 text-sm font-semibold text-heading">
                Storage
              </h2>
              <div className="px-4 py-3 text-sm leading-relaxed text-body">
                {state.storage.mode === "postgres" ? (
                  <>
                    <p>
                      Postgres connected via DATABASE_URL. Tasks, runs, messages, and results persist
                      across restarts.
                    </p>
                    {!state.storage.ok && (
                      <p className="mt-2 text-err">Last storage check failed: {state.storage.error}</p>
                    )}
                  </>
                ) : (
                  <p>
                    Ephemeral mode: data is not persisted. The store lives in process memory and
                    resets on restart. Set DATABASE_URL to enable Postgres persistence; the schema is
                    applied automatically on first use.
                  </p>
                )}
              </div>
            </section>

            <section aria-labelledby="router-heading" className="panel">
              <h2 id="router-heading" className="border-b hairline px-4 py-3 text-sm font-semibold text-heading">
                Command router
              </h2>
              <div className="px-4 py-3 text-sm leading-relaxed text-body">
                {state.env.llmRouterActive ? (
                  <p>
                    LLM router active. Commands are classified by the model named in LLM_MODEL,
                    reached through LLM_BASE_URL with LLM_API_KEY. If a call fails, the dashboard
                    falls back to deterministic rules and says so in the feed.
                  </p>
                ) : (
                  <p>
                    Deterministic fallback router active (keyword rules). Set LLM_BASE_URL,
                    LLM_API_KEY, and LLM_MODEL together to enable LLM classification. The fallback
                    stays as the error path either way.
                  </p>
                )}
              </div>
            </section>

            <section aria-labelledby="swap-heading" className="panel">
              <h2 id="swap-heading" className="flex items-center gap-2 border-b hairline px-4 py-3 text-sm font-semibold text-heading">
                <Plugs aria-hidden className="size-4 text-accent" />
                Switching model provider
              </h2>
              <div className="px-4 py-3 text-sm leading-relaxed text-body">
                <p>
                  The adapter speaks OpenAI-compatible chat completions. Point LLM_BASE_URL at any
                  provider that implements it (OpenAI, Azure OpenAI gateways, OpenRouter, a local
                  vLLM or Ollama server), set LLM_API_KEY to that provider's key, and set LLM_MODEL to
                  a model name the provider recognizes. No code changes are needed, and the model
                  name is never hard-coded in the app.
                </p>
              </div>
            </section>

            <section aria-labelledby="add-heading" className="panel">
              <h2 id="add-heading" className="flex items-center gap-2 border-b hairline px-4 py-3 text-sm font-semibold text-heading">
                <Lightbulb aria-hidden className="size-4 text-accent" />
                Adding an agent
              </h2>
              <div className="space-y-2 px-4 py-3 text-sm leading-relaxed text-body">
                <p>
                  Agents are configuration, not hard-wired paths. Add a spec to{" "}
                  <span className="mono text-heading">src/server/agents/index.ts</span> with the
                  intents it handles, implement{" "}
                  <span className="mono text-heading">execute(task, ctx)</span> against permitted
                  tools, and return a structured result with provenance on every external field.
                </p>
                <p>
                  The Manager picks it up automatically on the next run, and it appears in the Agents
                  panel. Until a real capability exists, register the agent as{" "}
                  <span className="mono text-heading">awaiting</span> so it declines tasks honestly
                  instead of producing fake output.
                </p>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
