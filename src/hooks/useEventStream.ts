import { useEffect, useRef, useState } from "react";

import { fetchEventsSince } from "~/server/api";
import type { OrchestrationEvent } from "~/server/types";

/**
 * Client side of the live activity stream.
 *
 * The server persists a real orchestration event for every pipeline step.
 * This hook polls the cursor-based endpoint a few times a second and hands
 * back exactly the events that really happened, in the order they were
 * persisted. Nothing is synthesized or extrapolated client-side: if a row
 * shows here, the server recorded the step.
 *
 * Why polling instead of SSE: TanStack Start 1.168 has no API-file routes and
 * server functions serialize their return values, so there is no supported
 * way to hold a streaming Response open through the framework handler that
 * both the dev server and the published Bun server use. A cursor poll at
 * 600ms delivers every step sub-second with none of that risk.
 */
export const EVENT_POLL_MS = 600;
/** Client buffer cap: the stream keeps recent activity, full history lives in
 *  the task store and is browsable on the tasks pages. */
const MAX_BUFFER = 600;

export interface EventStream {
  /** Events accumulated since mount, ascending by seq. */
  events: OrchestrationEvent[];
  /** Transport/store error, surfaced honestly in the UI. */
  error: string | null;
  /** False until the first successful poll completes. */
  ready: boolean;
}

export function useEventStream(taskId?: string): EventStream {
  const [events, setEvents] = useState<OrchestrationEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const cursorRef = useRef(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      try {
        const res = await fetchEventsSince({
          data: { since: cursorRef.current, ...(taskId ? { taskId } : {}) },
        });
        if (!alive) return;
        if (res.ok) {
          cursorRef.current = Math.max(cursorRef.current, res.lastSeq);
          if (res.events.length > 0) {
            setEvents((prev) => {
              const next = [...prev, ...res.events];
              return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
            });
          }
          setError(null);
          setReady(true);
        } else {
          setError(res.error ?? "The event stream is unavailable.");
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) timer = setTimeout(() => void tick(), EVENT_POLL_MS);
      }
    };

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [taskId]);

  return { events, error, ready };
}

/** A ticking clock for elapsed-time displays. Ticks only while `active`, so
 *  idle pages do no work. Returns Date.now(). */
export function useNow(active: boolean, intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
