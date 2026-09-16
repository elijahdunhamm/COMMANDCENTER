import { createFileRoute } from "@tanstack/react-router";
import { Robot } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { AppHeader, StorageBanner } from "~/components/layout";
import { OfficeScene } from "~/components/office";
import { useEventStream } from "~/hooks/useEventStream";
import { fetchAgentsState } from "~/server/api";
import type { AgentsState } from "~/server/manager";

export const Route = createFileRoute("/office")({
  component: OfficePage,
});

const AGENTS_POLL_MS = 4000;

function OfficePage() {
  const stream = useEventStream();
  const [agentsState, setAgentsState] = useState<AgentsState | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const refreshAgents = useCallback(async () => {
    try {
      setAgentsState(await fetchAgentsState());
      setAgentsError(null);
    } catch (err) {
      setAgentsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshAgents();
    const id = setInterval(() => void refreshAgents(), AGENTS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshAgents]);

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main id="main" className="mx-auto max-w-[1100px] px-4 py-8 md:px-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-heading">
          <Robot aria-hidden className="size-5 text-accent" />
          Office
        </h1>
        <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-body">
          The five agents as robots on a shared office floor. The scene moves only when real
          orchestration events arrive: a robot walks to its station when its run starts, works
          while its tool calls run, and walks back when the run completes or fails. An agent with
          no events sits at its desk; a disabled agent sits dimmed.
        </p>

        <div className="mt-6">
          <StorageBanner storage={agentsState?.storage} />
          {agentsError && (
            <div role="alert" className="rounded-[10px] border border-err/40 bg-err/5 px-4 py-3 text-sm text-err">
              Could not load the agent registry: {agentsError} Robots still move from real events;
              the disabled treatment needs the registry.
            </div>
          )}
        </div>

        <div className="mt-6">
          <OfficeScene
            events={stream.events}
            agents={agentsState?.agents ?? null}
            error={stream.error}
            ready={stream.ready}
          />
        </div>

        <p className="mt-3 text-xs leading-relaxed text-muted">
          Hover, tap, or focus a robot to see its current real state. Every position and pose is
          derived from the same event stream the dashboard feed uses; nothing is simulated. With
          reduced motion enabled the scene renders static.
        </p>
      </main>
    </div>
  );
}
