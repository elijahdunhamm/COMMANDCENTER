/**
 * End-to-end smoke test. Runs the real pipeline with ZERO credentials:
 * deterministic router classifies sample commands, the Research Agent makes
 * real permitted API calls (Wikipedia, Nominatim), and structured results with
 * provenance come back. Also proves: scaffolded agents fail honestly, task
 * detail assembles fully, the saved-research library does real idempotent CRUD,
 * a disabled agent refuses tasks with an honest message (and un-disables),
 * orchestration events are real and ordered, the DealFinder Agent parses
 * local-service commands and searches OpenStreetMap via Overpass with per-hit
 * provenance and honest unavailable/empty/ask-for-location paths (the smoke
 * tolerates Overpass degradation explicitly; it asserts honesty, not uptime),
 * and the Opportunity Agent lead finder finds named businesses with no
 * website listed on OpenStreetMap via the same connector, with fixture-based
 * filter/ranking units plus weather-tolerant live runs.
 *
 * Run: bun run scripts/smoke.ts
 * Exit code 0 = all assertions passed.
 */
import { executeCommand, getDashboardState, deleteSavedResearch, getEventsSince, getSavedLibrary, getTaskDetail, saveResultToLibrary, setAgentEnabledState } from "../src/server/manager";
import { classifyCommand, classifyWithFallback, llmConfig } from "../src/server/model";
import { parseDealfinderQuery } from "../src/server/dealfinder/parser";
import { overpassEndpointCandidates, bboxForRadius, buildOverpassQuery } from "../src/server/dealfinder/overpass";
import { parseCodingDirectives } from "../src/server/agents/coding";
import { parseHnHit, rankStories, extractSearchTopic, isLeadCommand, extractAudience, leadSelectors, filterLeadElements, rankLeads, LEAD_CAP, LEAD_FETCH_LIMIT } from "../src/server/agents/opportunity";
import { isPlausibleWikiHit, pickPlausibleOpenSearchHit } from "../src/server/agents";
import { checkCommandPolicy } from "../src/server/tools/workspace";
import type { OverpassElement } from "../src/server/dealfinder/overpass";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRefusalResult, AgentView, CodingWorkResult, DealFinderSearchResult, DisabledAgentResult, OpportunityLeadsResult, OpportunityScanResult, OrchestrationEvent, ResearchBriefResult } from "../src/server/types";

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

  // 2. Coding Agent: real sandboxed work via the deterministic router.
  // A temp AGENT_WORKSPACE keeps the sandbox disposable; no network is used.
  console.log("\n-- coding agent: sandboxed list/write/version via fallback router --");
  const ws = mkdtempSync(path.join(tmpdir(), "smoke-agent-ws-"));
  writeFileSync(path.join(ws, "hello.txt"), "hello from the smoke workspace\n", "utf8");
  const prevWs = process.env.AGENT_WORKSPACE;
  process.env.AGENT_WORKSPACE = ws;
  const res2 = await executeCommand("list the files in the workspace and write notes.txt with smoke was here");
  check("second command ok", res2.ok === true, JSON.stringify(res2));
  const state2 = await getDashboardState();
  const task2 = state2.tasks.find((t) => t.id === res2.taskId);
  check("coding task routed to coding agent", task2?.agentId === "coding", JSON.stringify(task2));
  check("coding task completed via fallback router", task2?.status === "completed" && task2.router === "fallback", JSON.stringify(task2));
  const result2 = res2.taskId ? state2.results[res2.taskId] : undefined;
  const codingPayload = result2?.payload as CodingWorkResult | undefined;
  check("coding result kind is coding.work", codingPayload?.kind === "coding.work", String(result2?.payload?.kind));
  check("coding result names the real sandbox root", codingPayload?.workspaceRoot === path.resolve(ws), codingPayload?.workspaceRoot);
  check(
    "coding operations: list + write really executed",
    codingPayload?.operations.length === 2 &&
      codingPayload.operations[0]?.op === "list" &&
      codingPayload.operations[0]?.ok === true &&
      codingPayload.operations[1]?.op === "write" &&
      codingPayload.operations[1]?.ok === true,
    JSON.stringify(codingPayload?.operations),
  );
  const notesOnDisk = codingPayload ? await import("node:fs/promises").then((fs) => fs.readFile(path.join(ws, "notes.txt"), "utf8")) : "";
  check("written file really exists on disk with the requested content", notesOnDisk.includes("smoke was here"), JSON.stringify(notesOnDisk));
  const codingRun = res2.taskId ? state2.runs[res2.taskId]?.[0] : undefined;
  check(
    "coding tool calls are workspace-local (no network requests)",
    (codingRun?.toolCalls.length ?? 0) === 2 && codingRun!.toolCalls.every((c) => c.request.includes(ws) || c.request.startsWith("workspace ")),
    JSON.stringify(codingRun?.toolCalls),
  );
  const codingAgentView = state2.agents.find((a) => a.id === "coding");
  check("coding agent shows completed status after a real run", codingAgentView?.status === "completed", String(codingAgentView?.status));

  console.log("\n-- coding agent: honest refusals (outside sandbox, off-whitelist) --");
  const resRef = await executeCommand("cat /etc/passwd");
  const stateRef = await getDashboardState();
  const taskRef = stateRef.tasks.find((t) => t.id === resRef.taskId);
  check("outside-sandbox read is routed to the coding agent", taskRef?.agentId === "coding", JSON.stringify(taskRef));
  check("outside-sandbox read is failed honestly, not silently skipped", taskRef?.status === "failed", String(taskRef?.status));
  const refusePayload = resRef.taskId ? (stateRef.results[resRef.taskId]?.payload as AgentRefusalResult | undefined) : undefined;
  check(
    "refusal result kind is agent.refused with reason outside_workspace",
    refusePayload?.kind === "agent.refused" && refusePayload.reason === "outside_workspace",
    JSON.stringify(refusePayload),
  );
  check("refusal message names the sandbox and states nothing was executed", Boolean(refusePayload?.message.includes("nothing was read, written, or executed")), refusePayload?.message);
  const resCmd = await executeCommand("run curl https://example.com");
  const stateCmd = await getDashboardState();
  const cmdPayload = resCmd.taskId ? (stateCmd.results[resCmd.taskId]?.payload as AgentRefusalResult | undefined) : undefined;
  check(
    "non-whitelisted command is refused as command_not_allowed",
    cmdPayload?.kind === "agent.refused" && cmdPayload.reason === "command_not_allowed" && cmdPayload.message.includes("curl"),
    JSON.stringify(cmdPayload),
  );
  check(
    "no https request was ever recorded for the refused runs",
    [resRef.taskId, resCmd.taskId].every(
      (id) => id == null || (stateRef.runs[id] ?? stateCmd.runs[id] ?? []).every((r) => r.toolCalls.every((c) => !c.request.startsWith("https://"))),
    ),
    "all tool call requests are workspace-local",
  );
  const resUnk = await executeCommand("build a script that renames files");
  const stateUnk = await getDashboardState();
  const unkPayload = resUnk.taskId ? (stateUnk.results[resUnk.taskId]?.payload as AgentRefusalResult | undefined) : undefined;
  check(
    "a request with no permitted operation is refused with guidance, nothing executed",
    unkPayload?.kind === "agent.refused" && unkPayload.reason === "uninterpretable" && unkPayload.message.includes("list files"),
    JSON.stringify(unkPayload),
  );

  console.log("\n-- coding tool units: directive parsing and command policy --");
  const dirs = parseCodingDirectives("list the files and read hello.txt then run grep hello hello.txt");
  check(
    "directive parser maps list/read/command segments",
    dirs.directives.length === 3 &&
      dirs.directives[0]?.op === "list" &&
      dirs.directives[1]?.op === "read" &&
      dirs.directives[1]?.target === "hello.txt" &&
      dirs.directives[2]?.op === "command" &&
      dirs.directives[2]?.target === "grep hello hello.txt",
    JSON.stringify(dirs),
  );
  const pol1 = checkCommandPolicy("grep -rn pattern .");
  const pol2 = checkCommandPolicy("rm -rf /");
  const pol3 = checkCommandPolicy("find . -delete");
  const pol4 = checkCommandPolicy("bun --version");
  const pol5 = checkCommandPolicy("cat a.txt > b.txt");
  check(
    "command policy: grep allowed, rm refused, find -delete refused, bun --version allowed, redirect refused",
    pol1.allowed === true &&
      pol2.allowed === false &&
      pol3.allowed === false &&
      pol4.allowed === true &&
      pol5.allowed === false,
    JSON.stringify([pol1.reason, pol2.reason, pol3.reason, pol4.reason, pol5.reason]),
  );

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

  console.log("\n-- dealfinder: Overpass endpoint fallback list (no network) --");
  const savedOverpassEnv = process.env.OVERPASS_URL;
  try {
    delete process.env.OVERPASS_URL;
    const cDefault = overpassEndpointCandidates();
    check(
      "endpoint candidates: default first, then the two mirrors, in order",
      JSON.stringify(cDefault) === JSON.stringify([
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
      ]),
      JSON.stringify(cDefault),
    );
    process.env.OVERPASS_URL = "https://overpass.private.coffee/api/interpreter/";
    const cOverride = overpassEndpointCandidates();
    check(
      "OVERPASS_URL override is normalized (trailing slash) and takes first position, deduplicated",
      cOverride[0] === "https://overpass.private.coffee/api/interpreter" &&
        cOverride.length === 3 &&
        new Set(cOverride).size === cOverride.length,
      JSON.stringify(cOverride),
    );
    process.env.OVERPASS_URL = "https://overpass-api.de/api/interpreter";
    const cDup = overpassEndpointCandidates();
    check(
      "override equal to the default is deduplicated, order preserved",
      cDup.length === 3 && cDup[0] === "https://overpass-api.de/api/interpreter" && new Set(cDup).size === 3,
      JSON.stringify(cDup),
    );
  } finally {
    if (savedOverpassEnv === undefined) delete process.env.OVERPASS_URL;
    else process.env.OVERPASS_URL = savedOverpassEnv;
  }

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
    check(
      "unavailable note lists every endpoint that was tried",
      overpassEndpointCandidates().every((u) => (dpayload?.notes ?? []).some((n) => n.includes(u))),
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

  check(
    "recorded provenance URL belongs to one of the candidate endpoints (the one that answered)",
    Boolean(dpayload?.overpassUrl) &&
      overpassEndpointCandidates().some((u) => (dpayload?.overpassUrl ?? "").startsWith(u)),
    JSON.stringify({ overpassUrl: dpayload?.overpassUrl, candidates: overpassEndpointCandidates() }),
  );
  const dFallbackServed =
    Boolean(dpayload?.overpassUrl) &&
    !dpayload!.overpassUrl!.startsWith(overpassEndpointCandidates()[0]);
  if (dOverpassOk && dFallbackServed) {
    check(
      "when a fallback endpoint served the search, one honest note says so",
      (dpayload?.notes ?? []).some((n) => n.includes("fallback endpoint")),
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

  // 9. Opportunity Agent lead finder. Unit checks first (fixtures, no
  // network) for the missing-website Overpass filter and the lead ranking;
  // then live runs with the same source-weather tolerance as the dealfinder
  // checks: they assert honesty and structure, never source uptime.
  console.log("\n-- leads: deterministic units (no network) --");
  check("lead finder triggers on find-leads phrasing", isLeadCommand("find leads for web design clients in Austin") === true, String(isLeadCommand("find leads for web design clients in Austin")));
  check("lead finder triggers on find-me-leads phrasing", isLeadCommand("find me leads in Round Rock") === true, String(isLeadCommand("find me leads in Round Rock")));
  check("lead finder ignores explicit HN scans", isLeadCommand("scan hacker news for leads about AI tools") === false, String(isLeadCommand("scan hacker news for leads about AI tools")));
  check("lead finder ignores non-lead commands", isLeadCommand("Research the Eiffel Tower") === false, String(isLeadCommand("Research the Eiffel Tower")));
  check(
    "fallback router routes find-leads phrasing to the opportunity intent",
    classifyWithFallback("find leads for web design clients in Austin").intent === "opportunity",
    JSON.stringify(classifyWithFallback("find leads for web design clients in Austin")),
  );
  check(
    "audience phrase captured from the command",
    extractAudience("find leads for web design clients in Austin") === "web design clients",
    JSON.stringify(extractAudience("find leads for web design clients in Austin")),
  );
  check(
    "no audience phrase when the command has none",
    extractAudience("find leads in Austin") === null,
    JSON.stringify(extractAudience("find leads in Austin")),
  );

  const leadQuery = buildOverpassQuery(leadSelectors(), bboxForRadius(30.2672, -97.7431, 10), LEAD_FETCH_LIMIT);
  check(
    "lead Overpass query requires a name and excludes both website keys",
    leadQuery.includes('["name"]') && leadQuery.includes('[!"website"]') && leadQuery.includes('[!"contact:website"]'),
    leadQuery,
  );
  check(
    "lead Overpass query covers all five category keys",
    ["shop", "amenity", "craft", "office", "tourism"].every((k) => leadQuery.includes(`node["${k}"]`)),
    leadQuery,
  );
  check(
    "lead Overpass query fetches above the cap so ranking precedes capping",
    leadQuery.includes(`out center ${LEAD_FETCH_LIMIT}`) && LEAD_FETCH_LIMIT > LEAD_CAP,
    leadQuery.slice(-40),
  );

  // Fixture: raw Overpass-shaped elements run through the exact pure filter
  // the agent uses. This pins the missing-website filter logic with no network.
  const leadOrigin = { lat: 30.2672, lon: -97.7431 };
  const leadFixture: OverpassElement[] = [
    { type: "node", id: 1, lat: 30.268, lon: -97.744, center: null, tags: { name: "Main Street Cuts", shop: "hairdresser", phone: "+1 512 555 0100", "addr:street": "Main St" } },
    { type: "node", id: 2, lat: 30.268, lon: -97.744, center: null, tags: { name: "Already Online", shop: "cafe", website: "https://already.example" } },
    { type: "node", id: 3, lat: 30.268, lon: -97.744, center: null, tags: { name: "Webbed Homes", office: "estate_agent", "contact:website": "https://webbed.example" } },
    { type: "node", id: 4, lat: 30.268, lon: -97.744, center: null, tags: { shop: "clothes" } },
    { type: "node", id: 5, lat: 30.5, lon: -97.7431, center: null, tags: { name: "Far Away Shop", shop: "bakery" } },
    { type: "node", id: 6, lat: 30.268, lon: -97.744, center: null, tags: { amenity: "bench", name: "A Bench" } },
    { type: "node", id: 1, lat: 30.268, lon: -97.744, center: null, tags: { name: "Main Street Cuts", shop: "hairdresser" } },
    { type: "node", id: 7, lat: null, lon: null, center: null, tags: { name: "No Coords", shop: "car_repair" } },
    { type: "node", id: 8, lat: 30.269, lon: -97.745, center: null, tags: { name: "Mobile Only", craft: "plumber", "contact:mobile": "+1 512 555 0199" } },
  ];
  const lf = filterLeadElements(leadFixture, leadOrigin, 10);
  check(
    "fixture keeps exactly the named, categorized, website-less elements",
    lf.leads.length === 3,
    JSON.stringify(lf.leads.map((l) => l.name)),
  );
  check(
    "website-tagged elements excluded by the filter (both website and contact:website)",
    lf.skips.hasWebsiteTag === 2,
    JSON.stringify(lf.skips),
  );
  check("unnamed element excluded, not named by guesswork", lf.skips.noName === 1, JSON.stringify(lf.skips));
  check(
    "out-of-radius element excluded (bbox is square, the search area is a circle)",
    lf.skips.outsideRadius === 1,
    JSON.stringify(lf.skips),
  );
  check(
    "coordinate-less element excluded, duplicate collapsed",
    lf.skips.noCoords === 1 && lf.skips.duplicates === 1,
    JSON.stringify(lf.skips),
  );
  const keptLead = lf.leads.find((l) => l.name === "Main Street Cuts");
  check(
    "kept lead carries name, real category tags, computed distance, OSM url, address, and phone only from phone/contact:phone",
    Boolean(keptLead) && keptLead!.category === "shop=hairdresser" && keptLead!.phone === "+1 512 555 0100" &&
      keptLead!.address === "Main St" && keptLead!.osmUrl === "https://www.openstreetmap.org/node/1" && keptLead!.distanceMiles < 1,
    JSON.stringify(keptLead),
  );
  const mobileOnlyLead = lf.leads.find((l) => l.name === "Mobile Only");
  check(
    "contact:mobile is deliberately not collected as a phone",
    mobileOnlyLead != null && mobileOnlyLead.phone === null,
    JSON.stringify(mobileOnlyLead),
  );
  const benchLead = lf.leads.find((l) => l.name === "A Bench");
  check(
    "named amenities are reported with their real tags (the amenity caveat, stated in results)",
    benchLead != null && benchLead.category === "amenity=bench",
    JSON.stringify(benchLead),
  );

  const rankedLeads = rankLeads([
    { osmType: "node", osmId: 21, osmUrl: "https://www.openstreetmap.org/node/21", name: "B Alpha", category: "shop=x", address: null, phone: null, lat: 0, lon: 0, distanceMiles: 2.0, distanceKm: 3.21869 },
    { osmType: "node", osmId: 22, osmUrl: "https://www.openstreetmap.org/node/22", name: "A Beta", category: "shop=x", address: null, phone: null, lat: 0, lon: 0, distanceMiles: 2.0, distanceKm: 3.21869 },
    { osmType: "node", osmId: 23, osmUrl: "https://www.openstreetmap.org/node/23", name: "Z Far", category: "shop=x", address: null, phone: null, lat: 0, lon: 0, distanceMiles: 1.0, distanceKm: 1.60934 },
  ]);
  check(
    "lead ranking is distance ascending, ties broken by name",
    rankedLeads.map((l) => l.name).join(",") === "Z Far,A Beta,B Alpha",
    JSON.stringify(rankedLeads.map((l) => l.name)),
  );

  console.log("\n-- leads: no location means a structured ask, never a guess --");
  const nlres = await executeCommand("find leads for web design clients");
  check("no-location lead command executed ok", nlres.ok === true && Boolean(nlres.taskId), JSON.stringify(nlres));
  const nlstate = await getDashboardState();
  const nltask = nlstate.tasks.find((t) => t.id === nlres.taskId);
  check(
    "no-location lead command routed to the opportunity agent",
    nltask?.intent === "opportunity" && nltask?.agentId === "opportunity",
    JSON.stringify(nltask),
  );
  const nlpayload = (nlres.taskId ? nlstate.results[nlres.taskId]?.payload : undefined) as OpportunityLeadsResult | undefined;
  check(
    "lead result kind is opportunity.leads with the honest ask-for-location state",
    nlpayload?.kind === "opportunity.leads" && nlpayload?.askedForLocation === true && nlpayload?.origin === null && nlpayload?.leads.length === 0,
    JSON.stringify({ kind: nlpayload?.kind, asked: nlpayload?.askedForLocation, n: nlpayload?.leads.length }),
  );
  check(
    "the lead ask explains how to provide a location",
    (nlpayload?.notes ?? []).some((n) => n.includes("find leads for web design clients in Austin")),
    JSON.stringify(nlpayload?.notes),
  );
  check(
    "every lead result carries the listing-gap honesty framing",
    nlpayload?.websiteListingNote.includes("no website listed on OpenStreetMap") === true,
    JSON.stringify(nlpayload?.websiteListingNote),
  );
  const nlrun = nlres.taskId ? nlstate.runs[nlres.taskId]?.[0] : undefined;
  check(
    "no tool calls were made for the lead ask-for-location run",
    nlrun?.toolCalls.length === 0,
    JSON.stringify(nlrun?.toolCalls),
  );

  console.log("\n-- leads: live run against a real city (source-weather tolerant) --");
  const lfres = await executeCommand("find leads for web design clients in Austin");
  check("lead command executed ok", lfres.ok === true && Boolean(lfres.taskId), JSON.stringify(lfres));
  const lfstate = await getDashboardState();
  const lftask = lfstate.tasks.find((t) => t.id === lfres.taskId);
  check(
    "live lead command routed to the opportunity agent and completed",
    lftask?.intent === "opportunity" && lftask?.agentId === "opportunity" && lftask?.status === "completed",
    JSON.stringify(lftask),
  );
  const lfpayload = (lfres.taskId ? lfstate.results[lfres.taskId]?.payload : undefined) as OpportunityLeadsResult | undefined;
  check("live result kind is opportunity.leads", lfpayload?.kind === "opportunity.leads", String(lfpayload?.kind));
  check(
    "every lead result carries the listing-gap honesty framing (live run too)",
    lfpayload?.websiteListingNote.includes("no website listed on OpenStreetMap") === true,
    JSON.stringify(lfpayload?.websiteListingNote),
  );
  const lfrun = lfres.taskId ? lfstate.runs[lfres.taskId]?.[0] : undefined;
  const lfGeocodeOk = Boolean(lfrun?.toolCalls.some((c) => c.tool === "nominatim.search" && c.ok));
  if (lfGeocodeOk) {
    check(
      "geocoded origin carried real Nominatim provenance",
      lfpayload?.origin?.kind === "geocoded" && lfpayload?.origin?.provenance?.url.startsWith("https://nominatim.openstreetmap.org/") === true,
      JSON.stringify(lfpayload?.origin),
    );
  }
  const lfLeads = lfpayload?.leads ?? [];
  if (lfpayload?.askedForLocation) {
    check(
      "when geocoding fails the lead run still completes with an honest ask",
      (lfpayload?.notes ?? []).some((n) => n.includes("could not be geocoded") || n.includes("Geocoding for")),
      JSON.stringify(lfpayload?.notes),
    );
    console.log("   (Nominatim degraded right now: the honest ask-for-location lead path was verified)");
  } else if (lfpayload?.sourceUnavailable) {
    check(
      "unavailable lead path carries the honest note and the exact request URL",
      (lfpayload?.notes ?? []).some((n) => n.includes("unavailable")) && Boolean(lfpayload?.overpassUrl?.startsWith("https://")),
      JSON.stringify(lfpayload?.notes),
    );
    check(
      "unavailable lead note lists every endpoint that was tried",
      overpassEndpointCandidates().every((u) => (lfpayload?.notes ?? []).some((n) => n.includes(u))),
      JSON.stringify(lfpayload?.notes),
    );
    console.log("   (Overpass degraded right now: the honest-unavailable lead path was verified)");
  } else {
    check(
      "live lead search has an origin and a request URL",
      Boolean(lfpayload?.origin) && Boolean(lfpayload?.overpassUrl?.startsWith("https://")),
      JSON.stringify({ origin: lfpayload?.origin, url: lfpayload?.overpassUrl }),
    );
    check(
      "lead cap respected",
      lfLeads.length <= lfpayload!.leadCap && lfpayload!.leadCap === LEAD_CAP,
      JSON.stringify({ n: lfLeads.length, cap: lfpayload?.leadCap }),
    );
    check(
      "every lead carries provenance and an OSM object URL",
      lfLeads.every((l) => l.provenance.source.includes("Overpass") && l.provenance.url.startsWith("https://") && !Number.isNaN(Date.parse(l.provenance.fetchedAt)) && l.osmUrl.startsWith("https://www.openstreetmap.org/")),
      JSON.stringify(lfLeads[0]),
    );
    check(
      "leads are ranked nearest-first by computed distance",
      lfLeads.every((l) => l.distanceMiles >= 0) && lfLeads.every((l, i) => i === 0 || l.distanceMiles >= lfLeads[i - 1].distanceMiles),
      JSON.stringify(lfLeads.slice(0, 3).map((l) => Number(l.distanceMiles.toFixed(2)))),
    );
    check(
      "every lead is inside the radius",
      lfLeads.every((l) => l.distanceMiles <= (lfpayload?.radiusMiles ?? 0) + 0.0001),
      JSON.stringify(lfLeads.length > 0 ? Math.max(...lfLeads.map((l) => l.distanceMiles)) : null),
    );
    check(
      "the payload never claims a verified absence: the banned phrasing is nowhere in it",
      !JSON.stringify(lfpayload).includes("has no website"),
      "payload wording check",
    );
    const lfServedBy = lfpayload?.servedBy ?? null;
    check(
      "servedBy records the endpoint that answered the request",
      lfServedBy == null || overpassEndpointCandidates().some((u) => lfServedBy === u || (lfpayload?.overpassUrl ?? "").startsWith(lfServedBy)),
      JSON.stringify({ servedBy: lfpayload?.servedBy, url: lfpayload?.overpassUrl }),
    );
    if (lfpayload?.fallbackUsed) {
      check(
        "when a fallback endpoint served the lead search, one honest note says so",
        (lfpayload?.notes ?? []).some((n) => n.includes("fallback endpoint")),
        JSON.stringify(lfpayload?.notes),
      );
    }
    if (lfLeads.length === 0) {
      check(
        "empty lead area explains itself and cites the request URL",
        (lfpayload?.notes ?? []).some((n) => n.includes("No businesses matching the filter")) && Boolean(lfpayload?.overpassUrl),
        JSON.stringify(lfpayload?.notes),
      );
    }
  }
  const lfEvents = (await getEventsSince(0)).events.filter((e) => e.taskId === lfres.taskId);
  check(
    "lead events record the overpass.search tool call (started and finished)",
    lfEvents.some((e) => e.type === "tool_call.started" && e.data.tool === "overpass.search") &&
      lfEvents.some((e) => e.type === "tool_call.finished" && e.data.tool === "overpass.search"),
    JSON.stringify(lfEvents.map((e) => e.type)),
  );
  // 10. Opportunity Agent: the subject is reduced to its search topic before
  // querying. Fixture-driven unit checks prove the deterministic extraction
  // (including the stopword guardrail) and the HN parse/rank path with no
  // network; a live scan then proves the extracted topic was really the query.
  console.log("\n-- opportunity: topic extraction + HN parsing (fixtures, no network) --");
  const extractionFixture = JSON.parse(
    readFileSync(new URL("./fixtures/topic-extraction.fixture.json", import.meta.url), "utf8"),
  ) as { cases: { subject: string; expectedTopic: string; expectedExtracted: boolean }[] };
  check("topic extraction fixture has cases", extractionFixture.cases.length >= 15, String(extractionFixture.cases.length));
  for (const c of extractionFixture.cases) {
    const got = extractSearchTopic(c.subject);
    check(
      `extractSearchTopic: "${c.subject}" -> "${c.expectedTopic}"${c.expectedExtracted ? "" : " (guardrail keeps the full subject)"}`,
      got.topic === c.expectedTopic && got.extracted === c.expectedExtracted,
      JSON.stringify(got),
    );
  }

  const hnFixture = JSON.parse(readFileSync(new URL("./fixtures/hn-search.fixture.json", import.meta.url), "utf8")) as { hits: unknown[] };
  const hnParsed = hnFixture.hits
    .map((h) => parseHnHit(h as Parameters<typeof parseHnHit>[0]))
    .filter((s): s is NonNullable<ReturnType<typeof parseHnHit>> => s !== null);
  check("hn fixture parses 4 usable hits, dropping the titleless one", hnParsed.length === 4, String(hnParsed.length));
  const hnRanked = rankStories(hnParsed);
  check(
    "hn fixture ranks points desc, tie broken newest-first",
    hnRanked[0]?.objectId === "31000001" &&
      hnRanked[1]?.objectId === "31000003" &&
      hnRanked[2]?.objectId === "31000002" &&
      hnRanked[3]?.objectId === "31000004" &&
      hnRanked.every((s, i) => s.rank === i + 1),
    JSON.stringify(hnRanked.map((s) => `${s.rank}:${s.objectId}:${s.points}`)),
  );

  console.log("\n-- research: wikipedia search-fallback plausibility (fixture, no network) --");
  const wikiFixture = JSON.parse(readFileSync(new URL("./fixtures/wikipedia-search.fixture.json", import.meta.url), "utf8")) as {
    query: string;
    response: unknown;
    weak_overlap_response: unknown;
    empty_response: unknown;
  };
  const eiffelPick = pickPlausibleOpenSearchHit("Eifle Tower", wikiFixture.response);
  check(
    "plausibility: misspelled 'Eifle Tower' resolves to the real Eiffel Tower article",
    eiffelPick?.title === "Eiffel Tower" && eiffelPick.url === "https://en.wikipedia.org/wiki/Eiffel_Tower",
    JSON.stringify(eiffelPick),
  );
  check(
    "plausibility: a weak-overlap hit is rejected for the owner's typo'd phrase (no wrong article substituted)",
    pickPlausibleOpenSearchHit("esearch brief: business oppurtnites in local services", wikiFixture.weak_overlap_response) === null,
    "expected null",
  );
  check(
    "plausibility: empty search results give no candidate",
    pickPlausibleOpenSearchHit("Eifle Tower", wikiFixture.empty_response) === null &&
      pickPlausibleOpenSearchHit("Eifle Tower", undefined) === null,
    "expected null",
  );
  check(
    "plausibility: a subject with no content tokens never matches anything",
    isPlausibleWikiHit("in the of", "Anything at all", "whatever") === false,
    "expected false",
  );

  console.log("\n-- opportunity: live scan queries the extracted topic --");
  const ores = await executeCommand("find business opportunities in local services");
  check("opportunity command executed ok", ores.ok === true && Boolean(ores.taskId), JSON.stringify(ores));
  const ostate = await getDashboardState();
  const otask = ostate.tasks.find((t) => t.id === ores.taskId);
  check(
    "opportunity task routed to the Opportunity agent",
    otask?.intent === "opportunity" && otask?.agentId === "opportunity",
    JSON.stringify(otask),
  );
  const opayload = (ores.taskId ? ostate.results[ores.taskId]?.payload : undefined) as OpportunityScanResult | undefined;
  check("opportunity result kind is opportunity.scan", opayload?.kind === "opportunity.scan", String(opayload?.kind));
  check("original subject kept verbatim as topic", opayload?.topic === "business opportunities in local services", opayload?.topic);
  check(
    "hnQuery is the extracted topic, honestly labeled",
    opayload?.hnQuery === "local services" && opayload?.hnQuerySource === "extracted_topic",
    JSON.stringify({ hnQuery: opayload?.hnQuery, source: opayload?.hnQuerySource }),
  );
  check(
    "note explains the deterministic extraction",
    (opayload?.notes ?? []).some((n) => n.includes("deterministic") && n.includes("local services")),
    JSON.stringify(opayload?.notes),
  );
  const oHnCall = ores.taskId ? ostate.runs[ores.taskId]?.[0]?.toolCalls.find((c) => c.tool === "hn.search") : undefined;
  check(
    "the recorded hn.search request URL used the extracted topic",
    Boolean(oHnCall?.request.includes("query=local%20services")),
    oHnCall?.request,
  );
  if (opayload?.hnUnavailable) {
    console.log("   (HN is degraded right now: query provenance verified, story checks skipped)");
  } else {
    check(
      "real stories came back for the extracted topic, ranked points desc with provenance",
      (opayload?.stories.length ?? 0) > 0 &&
        opayload!.stories.every(
          (s, i) =>
            s.provenance.url.includes("query=local%20services") &&
            (i === 0 || opayload!.stories[i - 1].points >= s.points),
        ),
      JSON.stringify(opayload?.stories.slice(0, 2).map((s) => `${s.rank}:${s.points}`)),
    );
  }
  const oEvents = (await getEventsSince(0)).events.filter((e) => e.taskId === ores.taskId);
  check(
    "events record the hn.search tool call (started and finished)",
    oEvents.some((e) => e.type === "tool_call.started" && e.data.tool === "hn.search") &&
      oEvents.some((e) => e.type === "tool_call.finished" && e.data.tool === "hn.search"),
    JSON.stringify(oEvents.map((e) => e.type)),
  );

  console.log("\n-- research: live summary via the wikipedia search fallback --");
  const rres = await executeCommand("Research the Eifle Tower");
  check("misspelled research command executed ok", rres.ok === true && Boolean(rres.taskId), JSON.stringify(rres));
  const rstate = await getDashboardState();
  const rtask = rstate.tasks.find((t) => t.id === rres.taskId);
  check("misspelled subject routed to the research agent", rtask?.intent === "research", JSON.stringify(rtask));
  const rpayload = (rres.taskId ? rstate.results[rres.taskId]?.payload : undefined) as ResearchBriefResult | undefined;
  check("research result kind is research.brief", rpayload?.kind === "research.brief", String(rpayload?.kind));
  const rCalls = rres.taskId ? (rstate.runs[rres.taskId]?.[0]?.toolCalls ?? []) : [];
  if (rpayload?.summary?.text) {
    check(
      "fallback summary resolved with honest fallback provenance",
      rpayload.summary.provenance.source.includes("search fallback") &&
        rpayload.summaryFallback?.failedSummaryUrl.includes("/summary/Eifle_Tower") === true &&
        rpayload.summaryFallback.articleUrl.startsWith("https://en.wikipedia.org/wiki/Eiffel_Tower"),
      JSON.stringify(rpayload.summaryFallback),
    );
    check(
      "note records both the failed 404 slug and the article actually used",
      (rpayload.notes ?? []).some(
        (n) => n.includes("404") && n.includes("/summary/Eifle_Tower") && n.includes("Eiffel Tower"),
      ),
      JSON.stringify(rpayload.notes),
    );
    check(
      "run recorded 4 real tool calls (404 summary, search, fallback summary, nominatim)",
      rCalls.length === 4 && rCalls[0]?.status === 404 && rCalls.some((c) => c.tool === "wikipedia.search" && c.ok),
      JSON.stringify(rCalls.map((c) => `${c.tool}:${c.status}`)),
    );
  } else {
    check(
      "when the fallback does not resolve, the no-summary path still explains itself and never substitutes silently",
      (rpayload?.notes ?? []).length > 0 && rCalls.some((c) => c.tool === "wikipedia.search"),
      JSON.stringify({ notes: rpayload?.notes, calls: rCalls.map((c) => c.tool) }),
    );
    console.log("   (Wikipedia fallback did not resolve this run: the honest no-summary path was verified)");
  }
  const rEvents = (await getEventsSince(0)).events.filter((e) => e.taskId === rres.taskId);
  check(
    "events show the real fallback calls (wikipedia.search started and finished)",
    rEvents.some((e) => e.type === "tool_call.started" && e.data.tool === "wikipedia.search") &&
      rEvents.some((e) => e.type === "tool_call.finished" && e.data.tool === "wikipedia.search"),
    JSON.stringify(rEvents.map((e) => e.type)),
  );

  // 11. Office scene: the event-driven robot view. The scene is rendered
  // for real (react-dom/server) so these checks cover markup, tooltips, and
  // the honest-state derivation, not just source text.
  console.log("\n-- office scene --");
  const { renderToString } = await import("react-dom/server");
  const React = (await import("react")).default;
  const office = await import("../src/components/office");
  const noEmDash = (s: string): boolean => !/[\u2014\u2013]/.test(s);

  const idleHtml = renderToString(React.createElement(office.OfficeScene, { events: [], agents: null, error: null }));
  check(
    "office scene renders five robots",
    (idleHtml.match(/office-robot-slot/g) ?? []).length === 5,
    String((idleHtml.match(/office-robot-slot/g) ?? []).length),
  );
  check(
    "office scene shows every agent idle with zero events",
    (idleHtml.match(/aria-label="[^"]*idle at desk"/g) ?? []).length === 5,
    String((idleHtml.match(/aria-label="[^"]*idle at desk"/g) ?? []).length),
  );
  check(
    "office scene tooltips name all five agents",
    ["Manager", "Research", "Coding", "Opportunity", "DealFinder"].every((n) =>
      idleHtml.includes(n + " Agent"),
    ),
  );
  check("office scene copy has zero em-dashes", noEmDash(idleHtml));

  const t0 = Date.now();
  const ev = (seq: number, type: string, agentId: string | null, data: Record<string, unknown>, agoMs: number, runId: string | null = "run-1"): OrchestrationEvent => ({
    seq,
    id: "e" + seq,
    type: type as OrchestrationEvent["type"],
    taskId: "task-abc12345-xyz",
    runId,
    agentId: agentId as OrchestrationEvent["agentId"],
    at: new Date(t0 - agoMs).toISOString(),
    data,
  });

  const busy = [
    ev(1, "task.queued", null, { command: "Research X" }, 5000, null),
    ev(2, "run.started", "research", {}, 4000),
    ev(3, "tool_call.started", "research", { tool: "wikipedia.summary", request: "https://en.wikipedia.org/x" }, 900),
  ];
  const busyHtml = renderToString(React.createElement(office.OfficeScene, { events: busy, agents: null, error: null }));
  check(
    "office scene walks a robot out on run.started and works at its station",
    busyHtml.includes('data-pos="station"') && busyHtml.includes("calling wikipedia.summary"),
  );
  check(
    "office scene routes the Manager at its desk while a task is open",
    busyHtml.includes("Manager Agent - routing task"),
  );
  const busyOpportunity = [
    ev(1, "task.queued", null, { command: "find leads for web design clients in Austin" }, 5000, null),
    ev(2, "run.started", "opportunity", {}, 4000),
    ev(3, "tool_call.started", "opportunity", { tool: "overpass.search", request: "https://overpass-api.example/x" }, 900),
  ];
  const busyOpportunityHtml = renderToString(React.createElement(office.OfficeScene, { events: busyOpportunity, agents: null, error: null }));
  check(
    "office scene derives opportunity runs generically: robot at its station on an overpass.search call",
    busyOpportunityHtml.includes('data-pos="station"') && busyOpportunityHtml.includes("calling overpass.search"),
  );
  const walkStates = office.deriveOfficeState([ev(1, "run.started", "research", {}, 600)], null, t0);
  check(
    "office derivation is mid-walk inside the walk window",
    walkStates.find((s) => s.agentId === "research")?.mode === "walking-out",
    JSON.stringify(walkStates.map((s) => s.agentId + ":" + s.mode)),
  );

  const done = [ev(1, "run.started", "coding", {}, 9000), ev(2, "run.completed", "coding", { toolCallCount: 2 }, 2200)];
  const doneHtml = renderToString(React.createElement(office.OfficeScene, { events: done, agents: null, error: null }));
  check(
    "office scene celebrates a completed run back at the desk",
    doneHtml.includes("Coding Agent - completed task") && !doneHtml.includes('data-pos="station"'),
  );

  const failed = [ev(1, "run.started", "coding", {}, 9000), ev(2, "run.failed", "coding", { error: "boom" }, 2200)];
  const failedHtml = renderToString(React.createElement(office.OfficeScene, { events: failed, agents: null, error: null }));
  check(
    "office scene slumps on a failed run and says so honestly",
    failedHtml.includes("Coding Agent - run failed on task"),
  );

  const refused = [ev(1, "run.started", "research", { refused: true }, 1200), ev(2, "run.failed", "research", { refused: true, error: "agent disabled by owner; task refused" }, 800)];
  const refusedStates = office.deriveOfficeState(refused, null, t0);
  check(
    "office scene treats a refused run as a refusal, not a failure slump",
    refusedStates.find((s) => s.agentId === "research")?.mode === "refused",
    JSON.stringify(refusedStates.find((s) => s.agentId === "research")),
  );

  const agentView = (id: AgentView["id"], enabled: boolean): AgentView => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    kind: id === "manager" ? "manager" : "specialist",
    description: "test",
    capability: "ready",
    capabilities: [],
    handlesIntents: [],
    enabled,
    status: enabled ? "idle" : "disabled",
    lastRunAt: null,
    activeTaskId: null,
  });
  const agents = (["manager", "research", "coding", "opportunity", "dealfinder"] as const).map((id) =>
    agentView(id, id !== "research"),
  );
  const disabledHtml = renderToString(React.createElement(office.OfficeScene, { events: [], agents, error: null }));
  check(
    "office scene dims exactly the disabled agent with an honest tooltip",
    (disabledHtml.match(/data-disabled="true"/g) ?? []).length === 1 &&
      disabledHtml.includes("Research Agent - disabled by the owner"),
  );

  const officeSrc = readFileSync(new URL("../src/components/office.tsx", import.meta.url), "utf8");
  const officeRouteSrc = readFileSync(new URL("../src/routes/office.tsx", import.meta.url), "utf8");
  const layoutSrc = readFileSync(new URL("../src/components/layout.tsx", import.meta.url), "utf8");
  const cssSrc = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
  const KNOWN_EVENTS = new Set([
    "task.queued", "task.classified", "run.started", "tool_call.started", "tool_call.finished",
    "message.added", "run.completed", "run.failed", "task.completed", "task.failed",
  ]);
  const eventRefs = [...officeSrc.matchAll(/"(task|run|tool_call|message)\.[a-z_]+"/g)].map((m) => m[0].slice(1, -1));
  check(
    "office scene references only real orchestration event types",
    eventRefs.length > 0 && eventRefs.every((r) => KNOWN_EVENTS.has(r)),
    JSON.stringify([...new Set(eventRefs)]),
  );
  check("office route exists and is registered", officeRouteSrc.includes('createFileRoute("/office")'));
  check("office is in the primary nav", layoutSrc.includes('to: "/office"'));
  check(
    "office scene reuses the shared 600ms event stream",
    officeRouteSrc.includes("useEventStream") && officeSrc.includes("useNow"),
  );
  check(
    "office scene has a reduced-motion static variant",
    cssSrc
      .split("@media (prefers-reduced-motion: reduce)")
      .some((block) => block.includes("office-robot-slot") && block.includes("transition: none")),
  );
  check(
    "office scene source has zero em-dashes",
    noEmDash(officeSrc) && noEmDash(officeRouteSrc),
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
