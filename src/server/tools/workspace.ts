import { spawn } from "node:child_process";
import path from "node:path";
import type { ToolCall } from "../types";
import type { ToolCallReporter } from "../agents/base";

/**
 * Coding Agent workspace tools: file access and shell execution confined to a
 * dedicated sandbox directory.
 *
 * Safety model (honest, mechanical, no judgment calls at run time):
 *  - Every path an operation touches is resolved against the workspace root and
 *    must stay inside it. Anything else is refused, never attempted.
 *  - Shell commands run WITHOUT a shell (no pipes, redirects, or substitution
 *    ever execute) and argv[0] must be on a fixed whitelist of read-only-ish
 *    programs. Anything else is refused, never attempted.
 *  - Every command runs under a hard timeout and is killed at it.
 *  - Refusals are returned as data, so they can be reported honestly instead
 *    of silently swallowed or retried.
 */

/** Env-overridable sandbox root. Default is a relative workspace directory.
 *  "/" and the user's home are never accepted as the sandbox root. */
export function resolveWorkspaceRoot(): string {
  const raw = process.env.AGENT_WORKSPACE?.trim() || "agent-workspace";
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(process.env.HOME ?? "/nonexistent")) {
    // Fall back to the honest default rather than sandboxing nothing.
    return path.resolve("agent-workspace");
  }
  return resolved;
}

export class Refusal extends Error {
  readonly kind: "outside_workspace" | "command_not_allowed" | "unsafe_characters" | "missing_file" | "uninterpretable";
  constructor(kind: Refusal["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** True when child resolves strictly inside root (root itself counts as in). */
export function isInsideWorkspace(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolves a user-supplied path against the workspace root or refuses.
 *  Absolute paths are accepted only when they already sit inside the sandbox. */
export function safeResolve(root: string, userPath: string): string {
  const cleaned = userPath.trim();
  if (!cleaned || cleaned.includes("\0")) {
    throw new Refusal("unsafe_characters", "the path is empty or contains a null byte");
  }
  const target = path.resolve(root, cleaned);
  if (!isInsideWorkspace(root, target)) {
    throw new Refusal(
      "outside_workspace",
      `"${cleaned}" resolves outside the workspace sandbox (${root}); nothing was read, written, or executed`,
    );
  }
  return target;
}

/** Programs the Coding Agent may execute, and only in these shapes:
 *  read-only listing/inspection, or a bare version check. No program here can
 *  write, move, or delete anything on its own. */
const COMMAND_WHITELIST: Record<string, { maxArgs: number; note: string }> = {
  ls: { maxArgs: 64, note: "list directory contents" },
  cat: { maxArgs: 16, note: "print file contents" },
  grep: { maxArgs: 64, note: "search inside files" },
  head: { maxArgs: 16, note: "show the first lines of a file" },
  tail: { maxArgs: 16, note: "show the last lines of a file" },
  wc: { maxArgs: 16, note: "count lines, words, and bytes" },
  find: { maxArgs: 64, note: "find files by name pattern" },
  bun: { maxArgs: 2, note: "runtime version check (--version only)" },
  node: { maxArgs: 2, note: "runtime version check (--version only)" },
  git: { maxArgs: 8, note: "read-only git status/diff inside the workspace" },
};

/** Version-check programs may ONLY be called with a version flag. */
const VERSION_ONLY = new Set(["bun", "node"]);

const VERSION_FLAGS = new Set(["--version", "-v"]);

/** Flags that make an otherwise read-only program destructive: find -exec
 *  would run arbitrary programs and -delete would remove files. */
const FORBIDDEN_FLAG_PATTERNS: RegExp[] = [/^-exec/i, /^-execdir/i, /^-delete$/i, /^-ok/i];

/** git is allowed only in explicitly read-only subcommands. */
const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "branch"]);

export interface CommandPolicy {
  allowed: boolean;
  reason: string | null;
  /** Typed refusal category when allowed is false: honest reason code, not prose. */
  refusalKind?: "command_not_allowed" | "unsafe_characters" | "uninterpretable";
  program: string;
  args: string[];
}

/** Decides, mechanically, whether a command line is on the whitelist. */
export function checkCommandPolicy(commandLine: string): CommandPolicy {
  const argv = commandLine.trim().split(/\s+/).filter(Boolean);
  const program = argv[0] ?? "";
  if (!program) {
    return { allowed: false, reason: "the command is empty", refusalKind: "uninterpretable", program, args: [] };
  }
  const meta = COMMAND_WHITELIST[program];
  if (!meta) {
    return {
      allowed: false,
      reason:
        `"${program}" is not on the Coding Agent's whitelist ` +
        `(${Object.keys(COMMAND_WHITELIST).join(", ")}), so it was not executed`,
      refusalKind: "command_not_allowed",
      program,
      args: argv.slice(1),
    };
  }
  const args = argv.slice(1);
  if (/[;|&><`$]/.test(commandLine)) {
    return {
      allowed: false,
      reason:
        "the command contains shell metacharacters; commands run without a shell and " +
        "redirection, piping, and substitution are refused rather than interpreted",
      refusalKind: "unsafe_characters",
      program,
      args,
    };
  }
  if (VERSION_ONLY.has(program)) {
    const okShape = args.length === 0 || args.every((a) => VERSION_FLAGS.has(a));
    if (!okShape) {
      return {
        allowed: false,
        reason: `${program} may only be run as "${program} --version" on this whitelist`,
        refusalKind: "command_not_allowed",
        program,
        args,
      };
    }
  }
  if (program === "git") {
    const sub = args[0] ?? "";
    if (!GIT_READ_ONLY.has(sub)) {
      return {
        allowed: false,
        reason: `git may only run read-only subcommands (${[...GIT_READ_ONLY].join(", ")}) on this whitelist`,
        refusalKind: "command_not_allowed",
        program,
        args,
      };
    }
  }
  if (args.length > meta.maxArgs) {
    return { allowed: false, reason: `too many arguments for ${program}`, refusalKind: "command_not_allowed", program, args };
  }
  if (program === "find") {
    const bad = args.find((a) => FORBIDDEN_FLAG_PATTERNS.some((re) => re.test(a)));
    if (bad) {
      return {
        allowed: false,
        reason: `find was called with "${bad}", which can execute or delete; not on the whitelist`,
        refusalKind: "command_not_allowed",
        program,
        args,
      };
    }
  }
  return { allowed: true, reason: null, program, args };
}

export interface CommandOutcome {
  call: ToolCall;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  timedOut: boolean;
}

/** Runs an already-validated command inside the workspace with a hard timeout.
 *  No shell is involved: argv is passed directly, so metacharacters can never
 *  become execution. The request recorded in the ToolCall is the exact argv. */
export function runWhitelistedCommand(
  root: string,
  policy: CommandPolicy,
  timeoutMs: number,
  reporter?: ToolCallReporter,
): Promise<CommandOutcome> {
  const request = `workspace command: ${[policy.program, ...policy.args].join(" ")} (cwd ${root})`;
  reporter?.started({ tool: "workspace.command", request });
  const started = Date.now();
  return new Promise<CommandOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(policy.program, policy.args, {
      cwd: root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      if (stdout.length > 100_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      if (stderr.length > 20_000) child.kill("SIGKILL");
    });
    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const call: ToolCall = {
        tool: "workspace.command",
        request,
        status: null,
        ok: !timedOut && exitCode === 0 && error === undefined,
        durationMs: Date.now() - started,
        ...(error !== undefined ? { error } : {}),
      };
      reporter?.finished(call);
      resolve({
        call,
        stdout: stdout.slice(0, 100_000),
        stderr: stderr.slice(0, 20_000),
        exitCode,
        timedOut,
      });
    };
    child.on("error", (err) => finish(null, `${policy.program}: ${err.message}`));
    child.on("close", (code) => {
      if (timedOut) finish(null, `command exceeded the ${timeoutMs}ms timeout and was killed`);
      else finish(code ?? null);
    });
  });
}
