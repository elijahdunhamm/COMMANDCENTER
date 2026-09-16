/**
 * End-to-end smoke test. Runs the real pipeline with ZERO credentials:
 * deterministic router classifies sample commands, the Research Agent makes
 * real permitted API calls (Wikipedia, Nominatim), and structured results with
 * provenance come back. Also proves: scaffolded agents fail honestly, task
 * detail assembles fully, the saved-research library does real idempotent CRUD,
 * and a disabled agent refuses tasks with an honest message (and un-disables).
 *
 * Run: bun run scripts/smoke.ts
 * Exit code 0 = all assertions passed.
 */
import { executeCommand, getDashboardState, deleteSavedResearch, getSavedLibrary, getTaskDetail, saveResultToLibrary, setAgentEnabledState } from "../src/server/manager";
import { classifyWithFallback } from "../src/server/model";
import type { DisabledAgentResult, ResearchBriefResult } from "../src/server/types";

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

  // 7. Env honesty.
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
