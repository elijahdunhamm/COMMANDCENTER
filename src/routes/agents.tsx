import { createFileRoute } from "@tanstack/react-router";
import { Cpu, Power } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { AppHeader, StorageBanner } from "~/components/layout";
import { AGENT_STATUS_STYLES, Skeleton, StatusBadge } from "~/components/status";
import { fetchAgentsState, setAgentEnabled } from "~/server/api";
import type { AgentsState } from "~/server/manager";

export const Route = createFileRoute("/agents")({
  component: AgentsPage,
});

function ToggleControl({ agent, onToggled }: {
  agent: AgentsState["agents"][number];
  onToggled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The Manager Agent is the router every task passes through; disabling it
  // has no honest meaning, so the control refuses and says why.
  if (agent.id === "manager") {
    return (
      <p className="text-xs text-muted">
        The Manager Agent routes every task and cannot be disabled.
      </p>
    );
  }

  const nextEnabled = !agent.enabled;
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          setAgentEnabled({ data: { agentId: agent.id, enabled: nextEnabled } })
            .then((res) => {
              if (!res.ok) {
                setError(res.error ?? "The switch could not be changed.");
              } else {
                onToggled();
              }
            })
            .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false));
        }}
        className={
          nextEnabled
            ? "inline-flex items-center gap-1.5 rounded-[10px] bg-accent px-3 py-1.5 text-xs font-semibold text-ink transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            : "inline-flex items-center gap-1.5 rounded-[10px] border hairline bg-panel-2 px-3 py-1.5 text-xs font-medium text-heading transition-transform hover:border-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        }
      >
        <Power aria-hidden className="size-3.5" />
        {busy ? "Switching" : nextEnabled ? "Enable agent" : "Disable agent"}
      </button>
      <p className="mt-1.5 max-w-[48ch] text-xs text-muted">
        {nextEnabled
          ? "Re-enables routing to this agent. It will run tasks again with its real capabilities (or decline them if it has none)."
          : "Refuses new tasks immediately. In-flight runs finish or fail on their own; nothing is cancelled behind your back."}
      </p>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-err">
          {error}
        </p>
      )}
    </div>
  );
}

function AgentsPage() {
  const [state, setState] = useState<AgentsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchAgentsState());
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
          <Cpu aria-hidden className="size-5 text-accent" />
          Agents
        </h1>
        <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-body">
          Every registered agent with its real contract, capabilities, and status. The enable switch
          is a hard control: a disabled agent refuses tasks with an honest message instead of
          running.
        </p>

        <div className="mt-6">
          <StorageBanner storage={state?.storage} />
          {state && state.storage.ok && state.storage.mode === "ephemeral" && (
            <p className="mb-4 text-xs text-muted">
              Ephemeral mode note: the enable switches live in process memory here, so they reset
              when the process restarts. With DATABASE_URL set they persist like everything else.
            </p>
          )}
          {error && (
            <div role="alert" className="rounded-[10px] border border-err/40 bg-err/5 px-4 py-3 text-sm text-err">
              Could not load the agents: {error}
            </div>
          )}
        </div>

        {!state && !error && (
          <div className="panel mt-6" aria-hidden>
            <div className="divide-y hairline">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2 px-4 py-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))}
            </div>
          </div>
        )}

        {state && (
          <ul className="panel mt-6 divide-y hairline">
            {state.agents.map((agent) => (
              <li key={agent.id} className="px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-heading">
                    {agent.name}{" "}
                    <span className="mono ml-1 text-[11px] font-normal text-muted">
                      id: {agent.id}
                    </span>
                  </h2>
                  <div className="flex items-center gap-3">
                    <span
                      className={
                        agent.capability === "ready"
                          ? "rounded-full border border-ok/40 bg-ok/10 px-2.5 py-0.5 text-xs font-medium text-ok"
                          : "rounded-full border border-wait/40 bg-wait/10 px-2.5 py-0.5 text-xs font-medium text-wait"
                      }
                    >
                      {agent.capability === "ready" ? "capability: ready" : "capability: awaiting"}
                    </span>
                    <StatusBadge status={agent.status} styles={AGENT_STATUS_STYLES} />
                  </div>
                </div>

                <p className="mt-1.5 text-sm leading-relaxed text-body">{agent.description}</p>
                {agent.capability === "awaiting" && (
                  <p className="mt-1 text-xs text-wait">
                    Registered, not implemented. It declines tasks honestly instead of inventing
                    output.
                  </p>
                )}

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-heading">
                      Capabilities
                    </h3>
                    {agent.capabilities.length === 0 ? (
                      <p className="mt-1 text-xs text-muted">None implemented yet.</p>
                    ) : (
                      <ul className="mt-1 space-y-0.5">
                        {agent.capabilities.map((c) => (
                          <li key={c} className="text-xs text-muted">
                            {c}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-heading">
                      Handles intents
                    </h3>
                    {agent.handlesIntents.length === 0 ? (
                      <p className="mono mt-1 text-xs text-muted">
                        none ({agent.kind === "manager" ? "routes all of them" : "unused"})
                      </p>
                    ) : (
                      <p className="mono mt-1 text-xs text-muted">{agent.handlesIntents.join(", ")}</p>
                    )}
                    <p className="mono mt-1 text-[11px] text-muted">
                      last run: {agent.lastRunAt ? new Date(agent.lastRunAt).toLocaleString() : "never"}
                    </p>
                  </div>
                </div>

                <div className="mt-4 border-t hairline pt-3">
                  <ToggleControl agent={agent} onToggled={() => void refresh()} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
