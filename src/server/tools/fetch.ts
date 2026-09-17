import type { ToolCall } from "../types";
import type { ToolCallReporter } from "../agents/base";

/**
 * Shared permitted-HTTP tool. Every network call an agent makes goes through
 * here so it is reported as a real tool call (started/finished with the true
 * status and duration) and can never succeed silently.
 */

export const OPEN_DATA_UA =
  "DealFinder-CommandCenter/0.1 (personal AI dashboard research agent)";

/** Fetches JSON from a permitted URL with a timeout, reporting the call.
 *  Never throws: failures come back as an ok:false ToolCall. */
export async function timedFetchJson(
  tool: string,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  reporter?: ToolCallReporter,
): Promise<{ json: unknown | null; call: ToolCall }> {
  // Report the start before any work happens, so the live view shows the
  // row as running for exactly as long as the call really takes.
  reporter?.started({ tool, request: url });
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const durationMs = Date.now() - started;
    if (!res.ok) {
      const call: ToolCall = { tool, request: url, status: res.status, ok: false, durationMs };
      reporter?.finished(call);
      return { json: null, call };
    }
    const json = (await res.json()) as unknown;
    const call: ToolCall = { tool, request: url, status: res.status, ok: true, durationMs };
    reporter?.finished(call);
    return { json, call };
  } catch (err) {
    const call: ToolCall = {
      tool,
      request: url,
      status: null,
      ok: false,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
    reporter?.finished(call);
    return { json: null, call };
  }
}
