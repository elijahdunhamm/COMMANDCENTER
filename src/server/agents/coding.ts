import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentSpec,
  CodingOperation,
  CodingWorkResult,
  Task,
  ToolCall,
} from "../types";
import type { Agent, AgentExecution, ExecutionContext } from "./base";
import {
  Refusal,
  checkCommandPolicy,
  resolveWorkspaceRoot,
  runWhitelistedCommand,
  safeResolve,
} from "../tools/workspace";

/**
 * Coding Agent: real, sandboxed workspace work.
 *
 * What is genuinely implemented (no pretense beyond this):
 *  - list / read / write files, but ONLY inside the workspace sandbox
 *    (default ./agent-workspace, override with the AGENT_WORKSPACE env var).
 *  - run whitelisted read-only-ish shell commands (ls, cat, grep, head, tail,
 *    wc, find, git status/diff/log/show/branch, bun/node --version) inside the
 *    sandbox, without a shell, under a hard timeout.
 *
 * Everything else is an honest refusal: paths that resolve outside the
 * sandbox, non-whitelisted programs, shell metacharacters, and requests this
 * deterministic interpreter cannot map to a permitted operation. A refusal
 * names exactly what was asked and why nothing was done. When the owner
 * configures an LLM (LLM_* env vars) the Manager classifies tasks better, but
 * the operations here stay deterministic and sandboxed either way.
 */

const codingSpec: AgentSpec = {
  id: "coding",
  name: "Coding Agent",
  kind: "specialist",
  description:
    "Works inside a sandboxed local workspace: reads, writes, lists files, and runs whitelisted read-only commands.",
  capability: "ready",
  capabilities: [
    "List, read, and write files inside the workspace sandbox only",
    "Run whitelisted read-only commands (ls, cat, grep, git status, bun --version) with a hard timeout",
    "Refuse anything outside the sandbox or off the whitelist, reported as a refusal",
    "Provenance on every operation (paths, commands, sandbox root)",
  ],
  handlesIntents: ["coding"],
};

const CMD_TIMEOUT_MS = 5000;

interface Directive {
  op: "list" | "read" | "write" | "command";
  target: string;
  /** Explicit content for write directives, when the command supplied some. */
  content: string | null;
  /** The exact segment text, for honest reporting. */
  raw: string;
}

/** Generic nouns that must never be treated as a filename. */
const GENERIC_NOUNS = new Set([
  "files",
  "file",
  "folder",
  "folders",
  "directory",
  "dir",
  "workspace",
  "sandbox",
  "them",
  "it",
  "contents",
]);

/** Splits the command into segments, then maps each to a permitted directive.
 *  Returns directives plus the raw segments that could not be interpreted. */
export function parseCodingDirectives(command: string): {
  directives: Directive[];
  unrecognized: string[];
} {
  const segments = command
    .split(/\band\b|\bthen\b|[;,]|(?<!\w)\/(?=\s)|\n+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const directives: Directive[] = [];
  const unrecognized: string[] = [];

  for (const seg of segments) {
    const d = matchDirective(seg);
    if (d) directives.push(d);
    else unrecognized.push(seg);
  }
  return { directives, unrecognized };
}

function matchDirective(seg: string): Directive | null {
  const s = seg.trim();
  if (!s) return null;

  // run/exec <command line>
  const run = s.match(/^(?:please\s+)?(?:run|exec|execute)\s+(?:the\s+)?(?:command\s+)?(.+)$/i);
  if (run) {
    return { op: "command", target: run[1].trim(), content: null, raw: s };
  }
  // Standalone version checks ("bun --version") are safe as whole segments.
  if (/^(?:bun|node)\s+(?:--version|-v)$/i.test(s)) {
    return { op: "command", target: s, content: null, raw: s };
  }

  // write/create <file> [with|containing|saying <content>]
  const write = s.match(
    /^(?:please\s+)?(?:write|create|make|add|new)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:file\s+)?(?:called\s+|named\s+)?([A-Za-z0-9._/-]+)\s*(?:,\s*)?(?:with|containing|saying|content)\s+(.+)?$/i,
  );
  if (write) {
    const name = write[1];
    if (!GENERIC_NOUNS.has(name.toLowerCase()) && name.includes(".")) {
      let content = (write[2] ?? "").trim();
      if (content) {
        content = content.replace(/^["'`]+|["'`]+$/g, "");
      }
      return { op: "write", target: name, content: content || null, raw: s };
    }
  }
  // Bare "create notes.txt" / "make a file called notes.txt" (no content).
  const createBare = s.match(
    /^(?:please\s+)?(?:create|make|add|new|touch)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:file\s+)?(?:called\s+|named\s+)?([A-Za-z0-9._/-]+)$/i,
  );
  if (createBare) {
    const name = createBare[1];
    if (!GENERIC_NOUNS.has(name.toLowerCase()) && name.includes(".")) {
      return { op: "write", target: name, content: null, raw: s };
    }
  }

  // read/cat/show <file>
  const read = s.match(
    /^(?:please\s+)?(?:read|cat|show|open|print|view|display)\s+(?:the\s+|me\s+|this\s+)?(?:file\s+|contents\s+of\s+(?:the\s+)?file\s+)?([A-Za-z0-9._/-]+)$/i,
  );
  if (read && !GENERIC_NOUNS.has(read[1].toLowerCase())) {
    return { op: "read", target: read[1], content: null, raw: s };
  }

  // list files / ls / show the workspace
  if (
    /\b(list|show|see|what)\b.*\b(files?|directories?|folders?|workspace|sandbox|contents)\b/i.test(s) ||
    /^ls\b/i.test(s) ||
    /^list\b/i.test(s)
  ) {
    return { op: "list", target: "workspace root", content: null, raw: s };
  }

  return null;
}

function stubContent(fileName: string, task: string, workspaceRoot: string): string {
  return (
    `${fileName}\n` +
    `${"=".repeat(fileName.length)}\n\n` +
    `Written by the Coding Agent (sandboxed workspace runtime) on ${new Date().toISOString()}.\n` +
    `Task: "${task}"\n` +
    `Sandbox: ${workspaceRoot}\n\n` +
    `This file is a stub: the command did not specify content to write, and the\n` +
    `agent never invents content. Edit this file, or ask again with content,\n` +
    `e.g. "write ${fileName} with your text here".\n`
  );
}

async function reportFs(
  reporter: ExecutionContext["reporter"],
  op: CodingOperation["op"],
  request: string,
  work: () => Promise<{ ok: boolean; detail: string }>,
): Promise<{ call: ToolCall; ok: boolean; detail: string }> {
  reporter?.started({ tool: `workspace.${op}`, request });
  const started = Date.now();
  let ok = false;
  let detail = "";
  let error: string | undefined;
  try {
    const r = await work();
    ok = r.ok;
    detail = r.detail;
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.message : String(err);
    detail = `operation failed: ${error}`;
  }
  const call: ToolCall = {
    tool: `workspace.${op}`,
    request,
    status: null,
    ok,
    durationMs: Date.now() - started,
    ...(error ? { error } : {}),
  };
  reporter?.finished(call);
  return { call, ok, detail };
}

export const codingAgent: Agent = {
  spec: codingSpec,
  async execute(task: Task, ctx: ExecutionContext): Promise<AgentExecution> {
    const reporter = ctx.reporter;
    const root = resolveWorkspaceRoot();
    await mkdir(root, { recursive: true });

    const { directives, unrecognized } = parseCodingDirectives(task.command);
    const operations: CodingOperation[] = [];
    const toolCalls: ToolCall[] = [];
    const notes: string[] = [];

    if (unrecognized.length > 0) {
      notes.push(
        `These parts of the command did not map to a permitted operation and were not executed: ` +
          unrecognized.map((u) => `"${u}"`).join(", ") +
          `. Phrasings that work: "list files", "read notes.txt", ` +
          `"write notes.txt with some text", "run ls", "run bun --version".`,
      );
    }
    if (directives.length === 0) {
      // Nothing interpretable: refuse honestly rather than do nothing silently.
      const message =
        `The Coding Agent could not map this request to a sandboxed operation ` +
        `(workspace: ${root}), so nothing was executed. ` +
        `Requests that work: "list files", "read <file>", "write <file> with <content>", ` +
        `"run ls", "run grep foo notes.txt", "run bun --version". ` +
        `Arbitrary shell commands, network calls, and paths outside the sandbox are refused by policy.`;
      return {
        status: "failed",
        result: {
          kind: "agent.refused",
          agentId: codingSpec.id,
          reason: "uninterpretable",
          message,
        },
        toolCalls,
        error: "request did not map to any sandboxed operation; nothing was executed",
        summary: `Refused: no part of the request maps to a permitted sandboxed operation. ${message}`,
      };
    }

    for (const d of directives) {
      try {
        if (d.op === "list") {
          const request = `list ${root}`;
          const r = await reportFs(reporter, "list", request, async () => {
            const entries = await readdir(root, { withFileTypes: true });
            const names = entries
              .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
              .sort();
            return {
              ok: true,
              detail: names.length > 0 ? names.join("\n") : "(workspace is empty)",
            };
          });
          toolCalls.push(r.call);
          operations.push({
            op: "list",
            target: root,
            ok: r.ok,
            detail: r.detail.slice(0, 2000),
            refused: false,
          });
        } else if (d.op === "read") {
          let target: string;
          try {
            target = safeResolve(root, d.target);
          } catch (ref) {
            if (ref instanceof Refusal) {
              const request = `read ${d.target} (sandbox ${root})`;
              reporter?.started({ tool: "workspace.read", request });
              const call: ToolCall = {
                tool: "workspace.read",
                request,
                status: null,
                ok: false,
                durationMs: 0,
                error: `refused: ${ref.message}`,
              };
              reporter?.finished(call);
              toolCalls.push(call);
              operations.push({
                op: "read",
                target: d.target,
                ok: false,
                detail: `refused: ${ref.message}`,
                refused: true,
                refusalKind: ref.kind,
              });
              notes.push(`Refused read of "${d.target}": ${ref.message}.`);
              continue;
            }
            throw ref;
          }
          const request = `read ${target}`;
          const r = await reportFs(reporter, "read", request, async () => {
            const text = await readFile(target, "utf8");
            return {
              ok: true,
              detail: text.length > 2000 ? `${text.slice(0, 2000)}... (truncated)` : text,
            };
          });
          toolCalls.push(r.call);
          operations.push({
            op: "read",
            target: target,
            ok: r.ok,
            detail: r.detail,
            refused: false,
          });
          if (!r.ok) notes.push(`Could not read "${d.target}": ${r.detail}`);
        } else if (d.op === "write") {
          let target: string;
          try {
            target = safeResolve(root, d.target);
          } catch (ref) {
            if (ref instanceof Refusal) {
              const request = `write ${d.target} (sandbox ${root})`;
              reporter?.started({ tool: "workspace.write", request });
              const call: ToolCall = {
                tool: "workspace.write",
                request,
                status: null,
                ok: false,
                durationMs: 0,
                error: `refused: ${ref.message}`,
              };
              reporter?.finished(call);
              toolCalls.push(call);
              operations.push({
                op: "write",
                target: d.target,
                ok: false,
                detail: `refused: ${ref.message}`,
                refused: true,
                refusalKind: ref.kind,
              });
              notes.push(`Refused write of "${d.target}": ${ref.message}.`);
              continue;
            }
            throw ref;
          }
          const content = d.content ?? stubContent(path.basename(target), task.command, root);
          const request = `write ${target} (${Buffer.byteLength(content, "utf8")} bytes)`;
          const r = await reportFs(reporter, "write", request, async () => {
            await writeFile(target, content, "utf8");
            return { ok: true, detail: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${target}` };
          });
          toolCalls.push(r.call);
          operations.push({
            op: "write",
            target: target,
            ok: r.ok,
            detail: r.detail,
            refused: false,
          });
          if (d.content == null) {
            notes.push(`"${d.target}" was created as an honest stub (no content was supplied in the command).`);
          }
        } else {
          // command
          const policy = checkCommandPolicy(d.target);
          if (!policy.allowed) {
            const request = `workspace command: ${d.target} (sandbox ${root})`;
            reporter?.started({ tool: "workspace.command", request });
            const call: ToolCall = {
              tool: "workspace.command",
              request,
              status: null,
              ok: false,
              durationMs: 0,
              error: `refused: ${policy.reason}`,
            };
            reporter?.finished(call);
            toolCalls.push(call);
            operations.push({
              op: "command",
              target: d.target,
              ok: false,
              detail: `refused: ${policy.reason}`,
              refused: true,
              refusalKind: policy.refusalKind ?? "command_not_allowed",
            });
            notes.push(`Refused command "${d.target}": ${policy.reason}.`);
            continue;
          }
          const outcome = await runWhitelistedCommand(root, policy, CMD_TIMEOUT_MS, reporter);
          toolCalls.push(outcome.call);
          const detail = outcome.timedOut
            ? `command was killed after the ${CMD_TIMEOUT_MS}ms timeout`
            : outcome.call.ok
              ? `exit ${outcome.exitCode}${outcome.stdout ? `; output:\n${outcome.stdout.trim().slice(0, 2000)}` : " (no output)"}`
              : `exit ${outcome.exitCode ?? "signal"}${outcome.stderr ? `; stderr:\n${outcome.stderr.trim().slice(0, 1000)}` : ""}`;
          operations.push({
            op: "command",
            target: `${policy.program} ${policy.args.join(" ")}`.trim(),
            ok: outcome.call.ok,
            detail,
            refused: false,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        operations.push({
          op: d.op,
          target: d.target,
          ok: false,
          detail: `unexpected failure: ${msg}`,
          refused: false,
        });
        notes.push(`Operation "${d.raw}" failed unexpectedly: ${msg}`);
      }
    }

    const refusedOps = operations.filter((o) => o.refused);
    const failedOps = operations.filter((o) => !o.ok && !o.refused);
    const okOps = operations.filter((o) => o.ok);

    // A run whose every operation was refused is reported as a refusal; mixed
    // runs keep the full operation record so the real work stays visible.
    if (refusedOps.length > 0 && okOps.length === 0) {
      const kinds = [
        ...new Set(refusedOps.map((o) => o.refusalKind).filter((k): k is NonNullable<typeof k> => k != null)),
      ];
      const reason = kinds.length === 1 ? kinds[0] : "policy_refusal";
      const message =
        `Every requested operation was refused by the sandbox policy, so nothing was executed. ` +
        `Refusals: ${refusedOps.map((o) => `"${o.target}" (${o.detail})`).join("; ")}. ` +
        `Sandbox root: ${root}.`;
      return {
        status: "failed",
        result: {
          kind: "agent.refused",
          agentId: codingSpec.id,
          reason,
          message,
        },
        toolCalls,
        error: message,
        summary: `Refused: ${refusedOps.length} operation(s) violated the sandbox policy; nothing was executed.`,
      };
    }

    const result: CodingWorkResult = {
      kind: "coding.work",
      task: task.command,
      workspaceRoot: root,
      operations,
      notes,
    };

    const status = refusedOps.length === 0 && failedOps.length === 0 ? "completed" : "failed";
    const error =
      refusedOps.length > 0
        ? `${refusedOps.length} operation(s) refused by sandbox policy`
        : failedOps.length > 0
          ? `${failedOps.length} operation(s) failed`
          : null;
    const parts = [
      `Worked in sandbox ${root}.`,
      `${okOps.length} operation(s) succeeded` +
        (refusedOps.length ? `, ${refusedOps.length} refused` : "") +
        (failedOps.length ? `, ${failedOps.length} failed` : "") +
        `.`,
    ];
    if (toolCalls.length === 0) parts.push("No tool calls were made.");
    return { status, result, toolCalls, error, summary: parts.join(" ") };
  },
};
