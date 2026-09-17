#!/usr/bin/env bun
/**
 * Headless agent runtime entry. Runs the SAME Manager/agent core the web app
 * uses (same registry, same router, same store contract, same tool modules),
 * with no web server.
 *
 *   bun run agent -- "list the files in the workspace"
 *   bun run agent --json -- "read notes.txt"
 *
 * Router: the LLM router runs only when LLM_BASE_URL, LLM_API_KEY, and
 * LLM_MODEL are all set (e.g. a local Ollama); otherwise the deterministic
 * fallback router classifies the command. Both are first-class and the output
 * always says which one ran.
 *
 * Storage: the same env-driven store as the app. Leave DATABASE_URL unset for
 * local runs and everything stays process-local (ephemeral, nothing leaves
 * the machine).
 *
 * Exit codes: 0 completed, 1 task failed or refused, 2 usage/storage error.
 */
import { executeCommand, getTaskDetail } from "../src/server/manager";
import { llmConfig } from "../src/server/model";
import { resolveWorkspaceRoot } from "../src/server/tools/workspace";
import type { ResultPayload } from "../src/server/types";

function usage(): string {
  return [
    "Usage: bun run agent -- \"<task text>\" [--json]",
    "",
    "Runs one task through the Manager Agent and prints an honest report:",
    "classification, routing, tool calls, and the structured result.",
    "",
    "Options:",
    "  --json   Machine-readable JSON of the full task detail.",
    "  --help   This text.",
    "",
    "Env (all optional):",
    "  LLM_BASE_URL / LLM_API_KEY / LLM_MODEL   OpenAI-compatible router; without them the deterministic fallback router is used.",
    "  AGENT_WORKSPACE                          Coding Agent sandbox root (default ./agent-workspace).",
    "  DATABASE_URL                             Leave unset for process-local (ephemeral) runs.",
  ].join("\n");
}

function renderPayload(p: ResultPayload): string[] {
  const lines: string[] = [];
  switch (p.kind) {
    case "coding.work": {
      lines.push(`Workspace: ${p.workspaceRoot}`);
      for (const op of p.operations) {
        const state = op.refused ? "REFUSED" : op.ok ? "ok" : "failed";
        lines.push(`  [${state}] ${op.op} ${op.target}`);
        if (op.detail) lines.push(`         ${op.detail.split("\n").join("\n         ")}`);
      }
      for (const n of p.notes) lines.push(`  note: ${n}`);
      break;
    }
    case "opportunity.scan": {
      if (p.hnQuery) {
        lines.push(
          `Queried with${p.hnQuerySource === "extracted_topic" ? " the extracted topic" : " the full subject"}: ${p.hnQuery}`,
        );
      }
      if (p.wiki?.text) {
        lines.push(`Context (Wikipedia, ${p.wiki.provenance.source}):`);
        lines.push(`  ${p.wiki.text.slice(0, 400)}${p.wiki.text.length > 400 ? "..." : ""}`);
        lines.push(`  ${p.wiki.articleUrl ?? "(no article url)"}`);
      }
      if (p.stories.length > 0) {
        lines.push(`Hacker News stories, ranked ${p.rankingRule}:`);
        for (const s of p.stories.slice(0, 10)) {
          lines.push(
            `  ${s.rank}. [${s.points} pts, ${s.numComments} comments] ${s.title}`,
          );
          lines.push(`     HN: ${s.hnUrl}${s.url ? ` | link: ${s.url}` : ""}`);
        }
      } else {
        lines.push("No story hits came back (see notes; nothing was invented to fill them).");
      }
      for (const n of p.notes) lines.push(`  note: ${n}`);
      break;
    }
    case "agent.refused":
      lines.push(`Refused (${p.reason}): ${p.message}`);
      break;
    case "agent.disabled":
    case "agent.capability_missing":
      lines.push(p.message);
      break;
    case "research.brief":
      lines.push(JSON.stringify(p, null, 2));
      break;
    default:
      lines.push(JSON.stringify(p, null, 2));
  }
  return lines;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  const asJson = argv.includes("--json");
  const parts = argv.filter((a) => a !== "--json" && a !== "--");
  const command = parts.join(" ").trim();

  if (!command) {
    console.error(usage());
    process.exit(2);
  }
  if (command.length > 2000) {
    console.error("Task text is limited to 2000 characters.");
    process.exit(2);
  }

  const cfg = llmConfig();
  const router =
    cfg != null
      ? `LLM router (model from LLM_MODEL; base URL from LLM_BASE_URL)`
      : "deterministic fallback router (no LLM env vars set)";
  const coding = resolveWorkspaceRoot();
  console.log(`agent runtime: headless (no web server)`);
  console.log(`router: ${router}`);
  console.log(`coding sandbox: ${coding}`);
  console.log(`task: ${command}`);
  console.log("");

  const res = await executeCommand(command);
  if (!res.ok || !res.taskId) {
    console.error(`The task could not be processed: ${res.error ?? "unknown error"}`);
    process.exit(2);
  }

  const detail = await getTaskDetail(res.taskId);
  if (!detail.ok || !detail.detail) {
    console.error(`Task record could not be loaded: ${detail.error ?? "unknown error"}`);
    process.exit(2);
  }
  const { task, runs, messages, result } = detail.detail;

  if (asJson) {
    console.log(JSON.stringify(detail.detail, null, 2));
    process.exit(task.status === "completed" ? 0 : 1);
  }

  console.log(`classification: intent=${task.intent ?? "unclassified"} router=${task.router ?? "?"}`);
  console.log(`routed to: ${task.agentId ?? "nobody"}`);
  console.log("");
  for (const run of runs) {
    console.log(`run ${run.id.slice(0, 8)}: ${run.status}`);
    for (const c of run.toolCalls) {
      console.log(
        `  tool ${c.tool}: ${c.ok ? "ok" : `FAILED (${c.status ?? c.error ?? "error"})`} in ${c.durationMs}ms`,
      );
      console.log(`    ${c.request}`);
    }
    if (run.error) console.log(`  error: ${run.error}`);
  }
  console.log("");
  if (result) {
    console.log(`result (${result.payload.kind}):`);
    for (const line of renderPayload(result.payload)) console.log(`  ${line}`);
  } else {
    console.log("no structured result was produced");
  }
  console.log("");
  const managerMsgs = messages.filter((m) => m.role === "manager");
  if (managerMsgs.length > 0) {
    console.log("manager report:");
    for (const m of managerMsgs) console.log(`  ${m.content}`);
  }
  console.log("");
  console.log(`task ${task.status}${task.error ? `: ${task.error}` : ""}`);
  process.exit(task.status === "completed" ? 0 : 1);
}

main().catch((err) => {
  console.error("agent runtime crashed:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
