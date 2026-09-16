/**
 * End-to-end smoke test. Runs the real pipeline with ZERO credentials:
 * deterministic router classifies a sample command, the Research Agent makes
 * real permitted API calls (Wikipedia, Nominatim), and a structured result
 * with provenance comes back. Also proves scaffolded agents fail honestly.
 *
 * Run: bun run scripts/smoke.ts
 * Exit code 0 = all assertions passed.
 */
import { executeCommand, getDashboardState } from "../src/server/manager";
import { classifyWithFallback } from "../src/server/model";
import type { ResearchBriefResult } from "../src/server/types";

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

  // 3. Env honesty.
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
