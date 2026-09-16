/**
 * End-to-end smoke test. Runs the real pipeline with ZERO credentials:
 * deterministic router classifies sample commands, the Research Agent makes
 * real permitted API calls (Wikipedia, Nominatim), and structured results with
 * provenance come back. Also proves: scaffolded agents fail honestly, task
 * detail assembles fully, the saved-research library does real idempotent CRUD,
 * a disabled agent refuses tasks with an honest message (and un-disables),
 * orchestration events are real and ordered, and the DealFinder Agent parses
 * local-service commands and searches OpenStreetMap via Overpass with per-hit
 * provenance and honest unavailable/empty/ask-for-location paths (the smoke
 * tolerates Overpass degradation explicitly; it asserts honesty, not uptime).
 *
 * Run: bun run scripts/smoke.ts
 * Exit code 0 = all assertions passed.
 */
import { executeCommand, getDashboardState, deleteSavedResearch, getEventsSince, getSavedLibrary, getTaskDetail, saveResultToLibrary, setAgentEnabledState } from "../src/server/manager";
import { classifyWithFallback } from "../src/server/model";
import { parseDealfinderQuery } from "../src/server/dealfinder/parser";
import type { DealFinderSearchResult, DisabledAgentResult, ResearchBriefResult } from "../src/server/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail && !ok ? ` :: ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  console.log("== smoke: zero-credential pipeline ==\n");

  // 0. Deterministic router unit checks (no network).
  const c1 = classifyWithFallback("Research the Eiffel Tower and tell me where it is located");
  check("fallback router classifies research", c1.intent === "research", JSON.stringify(c1));
  check("fallback router extracts subject", c1.subject.toLowerCase() === "eiffel tower", c1.subject);

  const c2 = classifyWithFallback("Build a script that renames files");
  check("fallback router classifies coding", c2.intent === "coding", JSON.stringify(c2));

  const c3 = classifyWithFallback("Find me a low-taper barber within 10 miles under $40");
  check("fallback router classifies dealfinder", c3.intent === "dealfinder", JSON.stringify(c3));

  // 1. Full pipeline: research command (real network calls).
  console.log("\n-- executing: 'Research the Eiffel Tower and tell me where it is located' --");
  const res = await executeCommand("Research the Eiffel Tower and tell me where it is located");
  check("executeCommand returned ok", res.ok === true && Boolean(res.taskId), JSON.stringify(res));

  const state = await getDashboardState();
  const task = state.tasks.find((t) => t.id === res.taskId);
  check("task persisted with intent research", task?.intent === "research", JSON.stringify(task));
  check("task status completed", task?.status === "completed", String(task?.status));

  const run = res.taskId ? state.runs[res.taskId]?.[0] : undefined;
  check("run recorded", Boolean(run), JSON.stringify(run ?? null));
  check("run recorded 2 real tool calls", run?.toolCalls.length === 2, JSON.stringify(run?.toolCalls));
  check(
    "tool calls have provenance-grade request URLs",
    run?.toolCalls.every((c) => c.request.startsWith("https://")) === true,
    JSON.stringify(run?.toolCalls.map((c) => c.request)),
  );

  const result = res.taskId ? state.results[res.taskId] : undefined;
  check("structured result persisted", Boolean(result), JSON.stringify(result ?? null));
  const payload = result?.payload as ResearchBriefResult | undefined;
  check("result kind is research.brief", payload?.kind === "research.brief", String(payload?.kind));
  check("summary section present", Boolean(payload?.summary?.text), JSON.stringify(payload?.summary));
  check(
    "summary has provenance (source + url + fetchedAt)",
    Boolean(
      payload?.summary?.provenance.source &&
        payload?.summary?.provenance.url.startsWith("https://en.wikipedia.org/") &&
        !Number.isNaN(Date.parse(payload?.summary?.provenance.fetchedAt ?? "x")),
    ),
    JSON.stringify(payload?.summary?.provenance),
  );
  check(
    "place section geocoded with provenance",
    Boolean(
      payload?.place?.lat != null &&
        payload?.place?.lon != null &&
        payload?.place?.provenance.url.includes("nominatim.openstreetmap.org"),
    ),
    JSON.stringify(payload?.place),
  );

  const msgs = state.messages.filter((m) => m.taskId === res.taskId);
  check("chat shows user + manager messages", msgs.length >= 3, `got ${msgs.length}`);
  check(
    "manager message names the fallback router honestly",
    msgs.some((m) => m.role === "manager" && m.content.includes("deterministic fallback router")),
    JSON.stringify(msgs.map((m) => m.content)),
  );

  const researchAgentView = state.agents.find((a) => a.id === "research");
  check("research agent shows completed status after real run", researchAgentView?.status === "completed", String(researchAgentView?.status));

  // 2. Scaffolded agent must fail honestly, never fabricate.
  console.log("\n-- executing: 'Build a script that renames files' (coding, scaffolded) --");
  const res2 = await executeCommand("Build a script that renames files");
  check("second command ok", res2.ok === true, JSON.stringify(res2));
  const state2 = await getDashboardState();
  const task2 = state2.tasks.find((t) => t.id === res2.taskId);
  check("coding task routed to coding agent", task2?.agentId === "coding", JSON.stringify(task2));
  check("coding task honestly failed", task2?.status === "failed", String(task2?.status));
  const result2 = res2.taskId ? state2.results[res2.taskId] : undefined;
  check(
    "scaffold reports capability_missing, no fabricated output",
    result2?.payload.kind === "agent.capability_missing",
    JSON.stringify(result2 ?? null),
  );
  const codingAgentView = state2.agents.find((a) => a.id === "coding");
  check("coding agent shows failed status", codingAgentView?.status === "failed", String(codingAgentView?.status));

  // 3. Task detail assembly: full timeline of task 1, both store modes.
  console.log("\n-- task detail: full timeline assembly --");
  const detail1 = res.taskId ? await getTaskDetail(res.taskId) : null;
  check("task detail loads", detail1?.ok === true && Boolean(detail1?.detail), JSON.stringify(detail1?.error));
  check(
    "detail has task + runs + messages + result",
    Boolean(
      detail1?.detail &&
        detail1.detail.task.intent === "research" &&
        detail1.detail.runs.length >= 1 &&
        detail1.detail.messages.length >= 3 &&
        detail1.detail.result !== null,
    ),
    JSON.stringify({ runs: detail1?.detail?.runs.length, msgs: detail1?.detail?.messages.length }),
  );
  check(
    "detail run carries the 2 real tool calls",
    detail1?.detail?.runs[0]?.toolCalls.length === 2,
    JSON.stringify(detail1?.detail?.runs[0]?.toolCalls),
  );

  // 4. Saved research library: real CRUD, idempotent per result.
  console.log("\n-- saved research: save, list, idempotence, delete --");
  const lib0 = await getSavedLibrary();
  check("library starts empty in this run", lib0.items.length === 0, JSON.stringify(lib0.items.length));
  const save1 = res.taskId ? await saveResultToLibrary(res.taskId) : null;
  check("save returns ok with id", save1?.ok === true && Boolean(save1?.savedId), JSON.stringify(save1));
  const save2 = res.taskId ? await saveResultToLibrary(res.taskId) : null;
  check(
    "second save of the same result is idempotent",
    save2?.ok === true && save2.savedId === save1?.savedId,
    JSON.stringify({ a: save1?.savedId, b: save2?.savedId }),
  );
  const lib1 = await getSavedLibrary();
  check("library lists exactly 1 item", lib1.items.length === 1, JSON.stringify(lib1.items.length));
  const savedItem = lib1.items[0];
  const savedPayload = savedItem?.payload as ResearchBriefResult | undefined;
  check(
    "saved item keeps payload + provenance intact",
    savedPayload?.kind === "research.brief" &&
      Boolean(savedPayload.summary?.provenance.url.startsWith("https://en.wikipedia.org/")),
    JSON.stringify(savedPayload?.summary?.provenance),
  );
  const saveBad = res2.taskId ? await saveResultToLibrary(res2.taskId) : null;
  check(
    "saving a non-research result is refused honestly",
    saveBad?.ok === false && typeof saveBad.error === "string",
    JSON.stringify(saveBad),
  );

  // 5. Agent enable/disable: a disabled agent refuses with an honest message.
  console.log("\n-- agent management: disable research, verify refusal, re-enable --");
  const toggleBad = await setAgentEnabledState("manager", false);
  check("manager cannot be disabled (honest refusal)", toggleBad.ok === false && Boolean(toggleBad.error), JSON.stringify(toggleBad));

  const off = await setAgentEnabledState("research", false);
  check("research agent disabled", off.ok === true && off.agent?.enabled === false, JSON.stringify(off));
  const stateOff = await getDashboardState();
  check(
    "dashboard shows research agent as disabled",
    stateOff.agents.find((a) => a.id === "research")?.status === "disabled",
    JSON.stringify(stateOff.agents.find((a) => a.id === "research")?.status),
  );

  console.log("\n-- executing: 'Research the Colosseum' against a disabled agent --");
  const res3 = await executeCommand("Research the Colosseum");
  check("refused command still returns ok (task recorded)", res3.ok === true && Boolean(res3.taskId), JSON.stringify(res3));
  const state3 = await getDashboardState();
  const task3 = state3.tasks.find((t) => t.id === res3.taskId);
  check("refused task is failed, not silently queued", task3?.status === "failed", String(task3?.status));
  check("refused task was routed to research agent", task3?.agentId === "research", String(task3?.agentId));
  const refusalResult = res3.taskId ? state3.results[res3.taskId] : undefined;
  const refusalPayload = refusalResult?.payload as DisabledAgentResult | undefined;
  check(
    "refusal result kind is agent.disabled with honest message",
    refusalPayload?.kind === "agent.disabled" &&
      typeof refusalPayload.message === "string" &&
      refusalPayload.message.includes("disabled"),
    JSON.stringify(refusalPayload),
  );
  const refusalRun = res3.taskId ? state3.runs[res3.taskId]?.[0] : undefined;
  check("refusal run recorded with ZERO tool calls", refusalRun?.status === "failed" && refusalRun.toolCalls.length === 0, JSON.stringify(refusalRun));
  check(
    "refusal message names the disabled agent",
    state3.messages.some((m) => m.taskId === res3.taskId && m.role === "manager" && m.content.includes("disabled")),
    JSON.stringify(state3.messages.filter((m) => m.taskId === res3.taskId).map((m) => m.content)),
  );

  const on = await setAgentEnabledState("research", true);
  check("research agent re-enabled", on.ok === true && on.agent?.enabled === true, JSON.stringify(on));
  const stateOn = await getDashboardState();
  check(
    "research agent no longer disabled",
    stateOn.agents.find((a) => a.id === "research")?.enabled === true &&
      stateOn.agents.find((a) => a.id === "research")?.status !== "disabled",
    JSON.stringify(stateOn.agents.find((a) => a.id === "research")?.status),
  );
  check(
    "research agent status honestly reflects the refusal run (failed)",
    stateOn.agents.find((a) => a.id === "research")?.status === "failed",
    JSON.stringify(stateOn.agents.find((a) => a.id === "research")?.status),
  );

  // 6. Delete from the library: real delete, verified.
  const del = savedItem ? await deleteSavedResearch(savedItem.id) : null;
  check("saved item deleted", del?.ok === true, JSON.stringify(del));
  const lib2 = await getSavedLibrary();
  check("library empty again after delete", lib2.items.length === 0, JSON.stringify(lib2.items.length));
  const delAgain = savedItem ? await deleteSavedResearch(savedItem.id) : null;
  check("deleting a missing item errors honestly", delAgain?.ok === false && Boolean(delAgain.error), JSON.stringify(delAgain));

  // 7. Orchestration events: real order, honest payloads, no phantom runs,
  // and the stream endpoint serves exactly what was persisted.
  console.log("\n-- orchestration events: real order, stream readback --");
  const streamAll = await getEventsSince(0);
  check(
    "stream endpoint serves persisted events",
    streamAll.ok === true && streamAll.events.length > 0,
    JSON.stringify({ ok: streamAll.ok, n: streamAll.events.length, error: streamAll.error }),
  );
  const seqs = streamAll.events.map((e) => e.seq);
  check(
    "event sequence numbers are strictly increasing",
    seqs.every((s, i) => i === 0 || s > seqs[i - 1]),
    JSON.stringify(seqs.slice(0, 20)),
  );

  const ev1 = streamAll.events.filter((e) => e.taskId === res.taskId);
  const expectedOrder = [
    "task.queued",
    "task.classified",
    "run.started",
    "tool_call.started",
    "tool_call.finished",
    "tool_call.started",
    "tool_call.finished",
    "run.completed",
    "task.completed",
  ];
  const order1 = ev1
    .map((e) => e.type)
    .filter((t) => expectedOrder.includes(t));
  check(
    "research run emits events in real order (queued, classified, run.started, tool_call x2, run.completed, task.completed)",
    JSON.stringify(order1) === JSON.stringify(expectedOrder),
    JSON.stringify(order1),
  );
  check(
    "tool_call.started and tool_call.finished arrive in pairs (2 calls, 2 starts, 2 finishes)",
    ev1.filter((e) => e.type === "tool_call.started").length === 2 &&
      ev1.filter((e) => e.type === "tool_call.finished").length === 2,
    JSON.stringify(ev1.map((e) => e.type)),
  );
  check(
    "classification event carries intent + router used",
    ev1.some(
      (e) =>
        e.type === "task.classified" &&
        e.data.intent === "research" &&
        e.data.router === "fallback",
    ),
    JSON.stringify(ev1.find((e) => e.type === "task.classified")),
  );
  check(
    "tool_call.finished events carry durationMs, status, and request URL, no secrets",
    ev1
      .filter((e) => e.type === "tool_call.finished")
      .every(
        (e) =>
          typeof e.data.durationMs === "number" &&
          e.data.durationMs >= 0 &&
          typeof e.data.ok === "boolean" &&
          typeof e.data.request === "string" &&
          e.data.request.startsWith("https://"),
      ),
    JSON.stringify(ev1.filter((e) => e.type === "tool_call.finished")),
  );

  // Refusal run (task 3): a run that genuinely never executed anything must
  // have run.started + run.failed and ZERO tool_call events.
  const ev3 = streamAll.events.filter((e) => e.taskId === res3.taskId);
  check(
    "refused task has run.started and run.failed but zero tool_call events",
    ev3.some((e) => e.type === "run.started") &&
      ev3.some((e) => e.type === "run.failed") &&
      ev3.every((e) => !e.type.startsWith("tool_call.")),
    JSON.stringify(ev3.map((e) => e.type)),
  );

  // No phantom references: every event names a task and run that really
  // exist in the store NOW (a fresh snapshot, since earlier sections ran
  // additional tasks after the original `state` was captured).
  const freshState = await getDashboardState();
  const knownTaskIds = new Set(freshState.tasks.map((t) => t.id));
  const knownRunIds = new Set(Object.values(freshState.runs).flat().map((r) => r.id));
  check(
    "every event references a task that really exists",
    streamAll.events.every((e) => e.taskId === null || knownTaskIds.has(e.taskId)),
    JSON.stringify(streamAll.events.filter((e) => e.taskId && !knownTaskIds.has(e.taskId)).slice(0, 2)),
  );
  check(
    "every run event references a run that really happened (no events for runs that never happened)",
    streamAll.events.every((e) => e.runId === null || knownRunIds.has(e.runId)),
    JSON.stringify(streamAll.events.filter((e) => e.runId && !knownRunIds.has(e.runId)).slice(0, 2)),
  );

  // Incremental cursor semantics: from a mid-log cursor, only later events
  // come back, and the head cursor matches the last persisted event.
  const mid = seqs[Math.floor(seqs.length / 2)] ?? 0;
  const stream2 = await getEventsSince(mid);
  check(
    "cursor read returns only events after the cursor",
    stream2.ok === true && stream2.events.every((e) => e.seq > mid) && stream2.lastSeq >= mid,
    JSON.stringify({ mid, got: stream2.events.map((e) => e.seq).slice(0, 10), lastSeq: stream2.lastSeq }),
  );
  const streamTail = await getEventsSince(streamAll.events[streamAll.events.length - 1].seq);
  check(
    "cursor at the head returns no events (nothing synthesized between polls)",
    streamTail.ok === true && streamTail.events.length === 0,
    JSON.stringify(streamTail.events.slice(0, 3)),
  );

  // 8. DealFinder Agent: deterministic parser units, real Overpass search with
  // provenance (or the honest unavailable path when the source is degraded:
  // overpass-api.de can refuse connections or return empty bodies under load,
  // so the smoke explicitly tolerates both outcomes), price-cap honesty, and
  // the structured ask-for-location outcome. No branch of these checks can
  // fail because of Overpass weather; they assert honesty, not reachability.
  console.log("\n-- dealfinder: deterministic parser units (no network) --");
  const p1 = parseDealfinderQuery("Find me a low-taper barber within 10 miles under $40");
  check("parser extracts barber service", p1.service?.key === "barber", JSON.stringify(p1.service));
  check("parser captures the 'low taper' specialty", p1.specialties.includes("low taper"), JSON.stringify(p1.specialties));
  check(
    "parser extracts the explicit 10-mile radius",
    p1.radius.value === 10 && p1.radius.unit === "miles" && p1.radius.source === "command",
    JSON.stringify(p1.radius),
  );
  check(
    "parser extracts the $40 price cap",
    p1.maxPrice?.amount === 40 && p1.maxPrice.currency === "USD",
    JSON.stringify(p1.maxPrice),
  );
  check(
    "parser finds no location in the flagship command (no guessing)",
    p1.coords === null && p1.place === null && !p1.unresolvableSelfLocation,
    JSON.stringify({ coords: p1.coords, place: p1.place }),
  );
  const p2 = parseDealfinderQuery("Find me a barber near 30.2672, -97.7431 within 10 miles");
  check(
    "parser extracts inline coordinates",
    p2.coords?.lat === 30.2672 && p2.coords?.lon === -97.7431,
    JSON.stringify(p2.coords),
  );
  const p3 = parseDealfinderQuery("hairdresser salon in Austin within 5 km");
  check(
    "parser maps salon phrasing to hairdresser, 5 km radius, place Austin",
    p3.service?.key === "hairdresser" && p3.radius.unit === "km" && p3.radius.value === 5 && p3.place === "Austin",
    JSON.stringify({ service: p3.service, radius: p3.radius, place: p3.place }),
  );
  const c4 = classifyWithFallback("Find a hairdresser near downtown Austin");
  check("fallback router classifies hairdresser search as dealfinder", c4.intent === "dealfinder", JSON.stringify(c4));

  console.log("\n-- dealfinder: real search near Austin center coordinates --");
  const dres = await executeCommand("Find me a barber near 30.2672, -97.7431 within 10 miles");
  check("dealfinder command executed ok", dres.ok === true && Boolean(dres.taskId), JSON.stringify(dres));
  const dstate = await getDashboardState();
  const dtask = dstate.tasks.find((t) => t.id === dres.taskId);
  check(
    "dealfinder task routed to the DealFinder Agent",
    dtask?.intent === "dealfinder" && dtask?.agentId === "dealfinder",
    JSON.stringify(dtask),
  );
  const drun = dres.taskId ? dstate.runs[dres.taskId]?.[0] : undefined;
  const dOverpassOk = drun?.toolCalls[0]?.ok === true;
  check(
    "dealfinder run recorded exactly one overpass.search tool call",
    drun?.toolCalls.length === 1 && drun.toolCalls[0].tool === "overpass.search",
    JSON.stringify(drun?.toolCalls),
  );
  const dresult = dres.taskId ? dstate.results[dres.taskId] : undefined;
  const dpayload = dresult?.payload as DealFinderSearchResult | undefined;
  check("result kind is dealfinder.search", dpayload?.kind === "dealfinder.search", String(dpayload?.kind));
  check(
    "service recorded as barber with the 10-mile radius",
    dpayload?.service?.key === "barber" && dpayload?.radiusMiles === 10,
    JSON.stringify({ service: dpayload?.service, radiusMiles: dpayload?.radiusMiles }),
  );

  const dUnavail = dpayload?.sourceUnavailable === true;
  const dHits = dpayload?.results ?? [];
  const dHitBranch = !dUnavail && dHits.length > 0;
  const dEmptyBranch = !dUnavail && dHits.length === 0;
  check(
    "exactly one honest outcome fired (source unavailable / results / empty area)",
    Number(dUnavail) + Number(dHitBranch) + Number(dEmptyBranch) === 1,
    JSON.stringify({ unavailable: dUnavail, hits: dHits.length }),
  );
  if (dUnavail) {
    check(
      "unavailable path carries the honest note and the exact request URL",
      (dpayload?.notes ?? []).some((n) => n.includes("unavailable")) &&
        Boolean(dpayload?.overpassUrl?.startsWith("https://")),
      JSON.stringify(dpayload?.notes),
    );
    console.log("   (Overpass is degraded right now: the honest-unavailable path was verified)");
  }
  if (dHitBranch) {
    check(
      "every hit carries provenance (source, request URL, fetched-at)",
      dHits.every(
        (h) =>
          h.provenance.source.includes("Overpass") &&
          h.provenance.url.startsWith("https://") &&
          !Number.isNaN(Date.parse(h.provenance.fetchedAt)),
      ),
      JSON.stringify(dHits[0]?.provenance),
    );
    check(
      "every price is honestly 'not verified' with an explanation",
      dHits.every((h) => h.price.verified === false && h.price.display === "not verified" && h.price.explanation.length > 0),
      JSON.stringify(dHits[0]?.price),
    );
    check(
      "distances are computed and ranked nearest-first",
      dHits.every((h) => h.distanceMiles >= 0) &&
        dHits.every((h, i) => i === 0 || h.distanceMiles >= dHits[i - 1].distanceMiles),
      JSON.stringify(dHits.slice(0, 3).map((h) => Number(h.distanceMiles.toFixed(2)))),
    );
    check(
      "all hits are inside the 10-mile radius (bbox is square, results are a circle)",
      dHits.every((h) => h.distanceMiles <= 10.0001),
      JSON.stringify(Math.max(...dHits.map((h) => h.distanceMiles))),
    );
    check(
      "why-lines reference real dimensions (computed distance)",
      dHits.every((h) => h.why.includes("computed")),
      JSON.stringify(dHits[0]?.why),
    );
  }
  if (dEmptyBranch) {
    check(
      "empty-area path explains itself and cites the request URL",
      (dpayload?.notes ?? []).some((n) => n.includes("No ")) && Boolean(dpayload?.overpassUrl?.startsWith("https://")),
      JSON.stringify(dpayload?.notes),
    );
  }

  const dEvents = (await getEventsSince(0)).events.filter((e) => e.taskId === dres.taskId);
  check(
    "events record the overpass.search tool call (started and finished)",
    dEvents.some((e) => e.type === "tool_call.started" && e.data.tool === "overpass.search") &&
      dEvents.some((e) => e.type === "tool_call.finished" && e.data.tool === "overpass.search"),
    JSON.stringify(dEvents.map((e) => e.type)),
  );

  console.log("\n-- dealfinder: price cap honesty (same origin+radius exercises the query cache) --");
  const pres = await executeCommand("Find me a barber under $40 near 30.2672, -97.7431");
  check("price-capped command executed ok", pres.ok === true && Boolean(pres.taskId), JSON.stringify(pres));
  const pstate = await getDashboardState();
  const ppayload = (pres.taskId ? pstate.results[pres.taskId]?.payload : undefined) as DealFinderSearchResult | undefined;
  check(
    "price cap parsed and persisted on the result",
    ppayload?.kind === "dealfinder.search" && ppayload?.maxPrice?.amount === 40,
    JSON.stringify(ppayload?.maxPrice),
  );
  check(
    "the result states plainly that prices could not be checked against OSM",
    (ppayload?.notes ?? []).some((n) => n.includes("Prices could not be checked")),
    JSON.stringify(ppayload?.notes),
  );
  if (dOverpassOk) {
    check(
      "identical Overpass query was served from the in-process cache",
      ppayload?.servedFromCache === true,
      String(ppayload?.servedFromCache),
    );
  }

  console.log("\n-- dealfinder: no location means a structured ask, never a guess --");
  const lres = await executeCommand("Find me a low-taper barber within 10 miles under $40");
  check("no-location command executed ok", lres.ok === true && Boolean(lres.taskId), JSON.stringify(lres));
  const lstate = await getDashboardState();
  const ltask = lstate.tasks.find((t) => t.id === lres.taskId);
  check("no-location task completed with a structured outcome", ltask?.status === "completed", String(ltask?.status));
  const lpayload = (lres.taskId ? lstate.results[lres.taskId]?.payload : undefined) as DealFinderSearchResult | undefined;
  check(
    "ask-for-location flag set, no origin, zero results",
    lpayload?.kind === "dealfinder.search" &&
      lpayload?.askedForLocation === true &&
      lpayload?.origin === null &&
      lpayload?.results.length === 0,
    JSON.stringify({ asked: lpayload?.askedForLocation, origin: lpayload?.origin, n: lpayload?.results.length }),
  );
  check(
    "specialty captured and explicitly marked unsearchable",
    (lpayload?.specialties ?? []).includes("low taper") && lpayload?.specialtySearchable === false,
    JSON.stringify({ specialties: lpayload?.specialties, searchable: lpayload?.specialtySearchable }),
  );
  check(
    "the ask explains how to provide a location",
    (lpayload?.notes ?? []).some((n) => n.includes("Provide a place name")),
    JSON.stringify(lpayload?.notes),
  );
  const lrun = lres.taskId ? lstate.runs[lres.taskId]?.[0] : undefined;
  check(
    "no tool calls were made for the ask-for-location run",
    lrun?.toolCalls.length === 0,
    JSON.stringify(lrun?.toolCalls),
  );
  const lEvents = (await getEventsSince(0)).events.filter((e) => e.taskId === lres.taskId);
  check(
    "ask-for-location task emitted zero tool_call events",
    lEvents.every((e) => !e.type.startsWith("tool_call.")),
    JSON.stringify(lEvents.map((e) => e.type)),
  );
  check(
    "manager chat message asks for a location honestly",
    lstate.messages.some(
      (m) => m.taskId === lres.taskId && m.role === "manager" && m.content.toLowerCase().includes("location"),
    ),
    JSON.stringify(lstate.messages.filter((m) => m.taskId === lres.taskId).map((m) => m.content)),
  );

  // 9. Env honesty.
  console.log("\n-- environment --");
  for (const v of state.env.vars) console.log(`   ${v.name}: ${v.set ? "set" : "missing"}`);
  console.log(`   storage mode: ${state.storage.mode}`);
  console.log(`   router: ${state.env.llmRouterActive ? "llm" : "deterministic fallback"}`);
  check("env reports LLM vars as missing in zero-credential run", state.env.llmRouterActive === false);

  console.log(
    `\n== smoke ${failures === 0 ? "PASSED" : `FAILED (${failures} failing check(s))`} ==`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
