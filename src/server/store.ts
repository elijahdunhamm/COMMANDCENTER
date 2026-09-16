import { SCHEMA_SQL } from "./schema";
import type {
  AgentId,
  AgentRun,
  AgentSpec,
  Intent,
  Message,
  RegisteredAgent,
  ResultPayload,
  ResultRecord,
  RouterKind,
  SavedRecord,
  Task,
  ToolCall,
} from "./types";

/**
 * Storage layer. Two implementations:
 *  - PostgresStore: used the moment DATABASE_URL is present (Neon serverless).
 *  - MemoryStore: process-local fallback so the app works with zero
 *    credentials. The UI labels this mode honestly ("ephemeral: data is not
 *    persisted").
 */

export type StorageMode = "postgres" | "ephemeral";

export interface StorageInfo {
  mode: StorageMode;
  ok: boolean;
  error: string | null;
}

export interface TaskPatch {
  intent?: Intent | null;
  router?: RouterKind | null;
  status?: Task["status"];
  agentId?: AgentId | null;
  error?: string | null;
}

export interface RunPatch {
  status?: AgentRun["status"];
  toolCalls?: ToolCall[];
  error?: string | null;
  finishedAt?: string | null;
}

export interface Store {
  readonly mode: StorageMode;
  /** Idempotent: apply schema (postgres) or nothing (memory). */
  ensureReady(): Promise<void>;
  info(): StorageInfo;

  createTask(command: string): Promise<Task>;
  updateTask(id: string, patch: TaskPatch): Promise<Task | null>;
  getTask(id: string): Promise<Task | null>;
  listTasks(limit: number): Promise<Task[]>;

  createRun(taskId: string, agentId: string): Promise<AgentRun>;
  updateRun(id: string, patch: RunPatch): Promise<AgentRun | null>;
  listRunsForTask(taskId: string): Promise<AgentRun[]>;
  listRecentRuns(limit: number): Promise<AgentRun[]>;

  createMessage(taskId: string | null, role: Message["role"], content: string): Promise<Message>;
  listMessages(limit: number): Promise<Message[]>;
  listMessagesForTask(taskId: string): Promise<Message[]>;

  saveResult(r: Omit<ResultRecord, "id" | "createdAt">): Promise<ResultRecord>;
  getResultForTask(taskId: string): Promise<ResultRecord | null>;

  /** Saved research library. Saving is idempotent per result: saving the same
   *  result twice returns the existing record instead of duplicating it. */
  saveToLibrary(rec: Omit<SavedRecord, "id" | "createdAt">): Promise<SavedRecord>;
  listSaved(): Promise<SavedRecord[]>;
  getSavedByResult(resultId: string): Promise<SavedRecord | null>;
  deleteSaved(id: string): Promise<boolean>;

  /** Agent registry (specs synced from code) plus the owner's enable flag. */
  upsertAgent(spec: AgentSpec): Promise<void>;
  getAgent(id: string): Promise<RegisteredAgent | null>;
  listAgents(): Promise<RegisteredAgent[]>;
  setAgentEnabled(id: string, enabled: boolean): Promise<RegisteredAgent | null>;
}

const nowIso = (): string => new Date().toISOString();

const randomId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

/* ------------------------------------------------------------------ memory */

class MemoryStore implements Store {
  readonly mode = "ephemeral" as const;
  private tasks = new Map<string, Task>();
  private runs = new Map<string, AgentRun>();
  private messages: Message[] = [];
  private results = new Map<string, ResultRecord>();
  private agents = new Map<string, RegisteredAgent>();
  private saved = new Map<string, SavedRecord>(); // keyed by result_id: save is idempotent

  async ensureReady(): Promise<void> {}
  info(): StorageInfo {
    return { mode: this.mode, ok: true, error: null };
  }

  async createTask(command: string): Promise<Task> {
    const t: Task = {
      id: randomId(),
      command,
      intent: null,
      router: null,
      status: "queued",
      agentId: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.tasks.set(t.id, t);
    return { ...t };
  }

  async updateTask(id: string, patch: TaskPatch): Promise<Task | null> {
    const t = this.tasks.get(id);
    if (!t) return null;
    const next: Task = { ...t, ...patch, updatedAt: nowIso() };
    this.tasks.set(id, next);
    return { ...next };
  }

  async getTask(id: string): Promise<Task | null> {
    const t = this.tasks.get(id);
    return t ? { ...t } : null;
  }

  async listTasks(limit: number): Promise<Task[]> {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((t) => ({ ...t }));
  }

  async createRun(taskId: string, agentId: string): Promise<AgentRun> {
    const r: AgentRun = {
      id: randomId(),
      taskId,
      agentId: agentId as AgentRun["agentId"],
      status: "working",
      toolCalls: [],
      error: null,
      startedAt: nowIso(),
      finishedAt: null,
    };
    this.runs.set(r.id, r);
    return { ...r, toolCalls: [] };
  }

  async updateRun(id: string, patch: RunPatch): Promise<AgentRun | null> {
    const r = this.runs.get(id);
    if (!r) return null;
    const next: AgentRun = { ...r, ...patch };
    this.runs.set(id, next);
    return { ...next, toolCalls: [...next.toolCalls] };
  }

  async listRunsForTask(taskId: string): Promise<AgentRun[]> {
    return [...this.runs.values()]
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((r) => ({ ...r, toolCalls: [...r.toolCalls] }));
  }

  async listRecentRuns(limit: number): Promise<AgentRun[]> {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((r) => ({ ...r, toolCalls: [...r.toolCalls] }));
  }

  async createMessage(
    taskId: string | null,
    role: Message["role"],
    content: string,
  ): Promise<Message> {
    const m: Message = { id: randomId(), taskId, role, content, createdAt: nowIso() };
    this.messages.push(m);
    return { ...m };
  }

  async listMessages(limit: number): Promise<Message[]> {
    return [...this.messages]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit)
      .map((m) => ({ ...m }));
  }

  async listMessagesForTask(taskId: string): Promise<Message[]> {
    return this.messages
      .filter((m) => m.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m) => ({ ...m }));
  }

  async saveResult(r: Omit<ResultRecord, "id" | "createdAt">): Promise<ResultRecord> {
    const rec: ResultRecord = { ...r, id: randomId(), createdAt: nowIso() };
    // Keep the latest result per task; the dashboard shows the current one.
    this.results.set(r.taskId, rec);
    return { ...rec, payload: structuredClone(rec.payload) as ResultPayload };
  }

  async getResultForTask(taskId: string): Promise<ResultRecord | null> {
    const rec = this.results.get(taskId);
    return rec ? { ...rec, payload: structuredClone(rec.payload) as ResultPayload } : null;
  }

  async saveToLibrary(rec: Omit<SavedRecord, "id" | "createdAt">): Promise<SavedRecord> {
    const existing = this.saved.get(rec.resultId);
    if (existing) return { ...existing, payload: structuredClone(existing.payload) as ResultPayload };
    const row: SavedRecord = { ...rec, id: randomId(), createdAt: nowIso() };
    this.saved.set(rec.resultId, row);
    return { ...row, payload: structuredClone(row.payload) as ResultPayload };
  }

  async listSaved(): Promise<SavedRecord[]> {
    return [...this.saved.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => ({ ...s, payload: structuredClone(s.payload) as ResultPayload }));
  }

  async getSavedByResult(resultId: string): Promise<SavedRecord | null> {
    const rec = this.saved.get(resultId);
    return rec ? { ...rec, payload: structuredClone(rec.payload) as ResultPayload } : null;
  }

  async deleteSaved(id: string): Promise<boolean> {
    for (const [key, rec] of this.saved) {
      if (rec.id === id) {
        this.saved.delete(key);
        return true;
      }
    }
    return false;
  }

  async upsertAgent(spec: AgentSpec): Promise<void> {
    // Registry syncs on every dashboard load; the owner's enable flag must
    // survive it, so an existing row keeps its flag and a new one defaults on.
    const prev = this.agents.get(spec.id);
    this.agents.set(spec.id, { ...spec, enabled: prev?.enabled ?? true });
  }

  async getAgent(id: string): Promise<RegisteredAgent | null> {
    const a = this.agents.get(id);
    return a ? { ...a } : null;
  }

  async listAgents(): Promise<RegisteredAgent[]> {
    return [...this.agents.values()].map((a) => ({ ...a }));
  }

  async setAgentEnabled(id: string, enabled: boolean): Promise<RegisteredAgent | null> {
    const a = this.agents.get(id);
    if (!a) return null;
    const next = { ...a, enabled };
    this.agents.set(id, next);
    return { ...next };
  }
}

/* ---------------------------------------------------------------- postgres */

type NeonSql = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<Record<string, unknown>[]>;
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
};

class PostgresStore implements Store {
  readonly mode = "postgres" as const;
  private sql: NeonSql | null = null;
  private ready = false;
  private infoState: StorageInfo = { mode: "postgres", ok: true, error: null };

  constructor(private url: string) {}

  info(): StorageInfo {
    return { ...this.infoState };
  }

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(this.url) as unknown as NeonSql;
    try {
      // Statements are split on ";" at the top level; SCHEMA_SQL has no
      // semicolons inside string literals, so a naive split is safe.
      for (const stmt of SCHEMA_SQL.split(";")) {
        const trimmed = stmt.trim();
        if (trimmed) await sql.query(trimmed);
      }
      this.sql = sql;
      this.ready = true;
      this.infoState = { mode: "postgres", ok: true, error: null };
    } catch (err) {
      this.infoState = {
        mode: "postgres",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      throw err;
    }
  }

  private q(): NeonSql {
    if (!this.sql) throw new Error("Postgres store is not ready (ensureReady failed)");
    return this.sql;
  }

  private ts(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    return value == null ? "" : String(value);
  }

  async createTask(command: string): Promise<Task> {
    const id = randomId();
    const rows = await this.q()`
      INSERT INTO tasks (id, command) VALUES (${id}, ${command})
      RETURNING id, command, intent, router, status, agent_id, error, created_at, updated_at`;
    return this.rowToTask(rows[0]);
  }

  async updateTask(id: string, patch: TaskPatch): Promise<Task | null> {
    const rows = await this.q()`
      UPDATE tasks SET
        intent     = COALESCE(${patch.intent ?? null}, intent),
        router     = COALESCE(${patch.router ?? null}, router),
        status     = COALESCE(${patch.status ?? null}, status),
        agent_id   = COALESCE(${patch.agentId ?? null}, agent_id),
        error      = COALESCE(${patch.error ?? null}, error),
        updated_at = now()
      WHERE id = ${id}
      RETURNING id, command, intent, router, status, agent_id, error, created_at, updated_at`;
    return rows[0] ? this.rowToTask(rows[0]) : null;
  }

  async getTask(id: string): Promise<Task | null> {
    const rows = await this.q()`
      SELECT id, command, intent, router, status, agent_id, error, created_at, updated_at
      FROM tasks WHERE id = ${id}`;
    return rows[0] ? this.rowToTask(rows[0]) : null;
  }

  async listTasks(limit: number): Promise<Task[]> {
    const rows = await this.q()`
      SELECT id, command, intent, router, status, agent_id, error, created_at, updated_at
      FROM tasks ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => this.rowToTask(r));
  }

  private rowToTask(r: Record<string, unknown>): Task {
    return {
      id: String(r.id),
      command: String(r.command),
      intent: (r.intent as Task["intent"]) ?? null,
      router: (r.router as Task["router"]) ?? null,
      status: r.status as Task["status"],
      agentId: (r.agent_id as AgentId | null) ?? null,
      error: (r.error as string | null) ?? null,
      createdAt: this.ts(r.created_at),
      updatedAt: this.ts(r.updated_at),
    };
  }

  async createRun(taskId: string, agentId: string): Promise<AgentRun> {
    const id = randomId();
    const rows = await this.q()`
      INSERT INTO agent_runs (id, task_id, agent_id) VALUES (${id}, ${taskId}, ${agentId})
      RETURNING id, task_id, agent_id, status, tool_calls, error, started_at, finished_at`;
    return this.rowToRun(rows[0]);
  }

  async updateRun(id: string, patch: RunPatch): Promise<AgentRun | null> {
    const rows = await this.q()`
      UPDATE agent_runs SET
        status      = COALESCE(${patch.status ?? null}, status),
        tool_calls  = COALESCE(${patch.toolCalls ? JSON.stringify(patch.toolCalls) : null}::jsonb, tool_calls),
        error       = COALESCE(${patch.error ?? null}, error),
        finished_at = COALESCE(${patch.finishedAt ?? null}, finished_at)
      WHERE id = ${id}
      RETURNING id, task_id, agent_id, status, tool_calls, error, started_at, finished_at`;
    return rows[0] ? this.rowToRun(rows[0]) : null;
  }

  async listRunsForTask(taskId: string): Promise<AgentRun[]> {
    const rows = await this.q()`
      SELECT id, task_id, agent_id, status, tool_calls, error, started_at, finished_at
      FROM agent_runs WHERE task_id = ${taskId} ORDER BY started_at ASC`;
    return rows.map((r) => this.rowToRun(r));
  }

  async listRecentRuns(limit: number): Promise<AgentRun[]> {
    const rows = await this.q()`
      SELECT id, task_id, agent_id, status, tool_calls, error, started_at, finished_at
      FROM agent_runs ORDER BY started_at DESC LIMIT ${limit}`;
    return rows.map((r) => this.rowToRun(r));
  }

  private rowToRun(r: Record<string, unknown>): AgentRun {
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      agentId: r.agent_id as AgentRun["agentId"],
      status: r.status as AgentRun["status"],
      toolCalls: (r.tool_calls as ToolCall[]) ?? [],
      error: (r.error as string | null) ?? null,
      startedAt: this.ts(r.started_at),
      finishedAt: r.finished_at == null ? null : this.ts(r.finished_at),
    };
  }

  async createMessage(
    taskId: string | null,
    role: Message["role"],
    content: string,
  ): Promise<Message> {
    const id = randomId();
    const rows = await this.q()`
      INSERT INTO messages (id, task_id, role, content)
      VALUES (${id}, ${taskId}, ${role}, ${content})
      RETURNING id, task_id, role, content, created_at`;
    const r = rows[0];
    return {
      id: String(r.id),
      taskId: r.task_id == null ? null : String(r.task_id),
      role: r.role as Message["role"],
      content: String(r.content),
      createdAt: this.ts(r.created_at),
    };
  }

  async listMessages(limit: number): Promise<Message[]> {
    const rows = await this.q()`
      SELECT id, task_id, role, content, created_at FROM messages
      ORDER BY created_at DESC LIMIT ${limit}`;
    return rows
      .map((r) => ({
        id: String(r.id),
        taskId: r.task_id == null ? null : String(r.task_id),
        role: r.role as Message["role"],
        content: String(r.content),
        createdAt: this.ts(r.created_at),
      }))
      .reverse();
  }

  async listMessagesForTask(taskId: string): Promise<Message[]> {
    const rows = await this.q()`
      SELECT id, task_id, role, content, created_at FROM messages
      WHERE task_id = ${taskId} ORDER BY created_at ASC`;
    return rows.map((r) => ({
      id: String(r.id),
      taskId: r.task_id == null ? null : String(r.task_id),
      role: r.role as Message["role"],
      content: String(r.content),
      createdAt: this.ts(r.created_at),
    }));
  }

  async saveResult(r: Omit<ResultRecord, "id" | "createdAt">): Promise<ResultRecord> {
    const id = randomId();
    const rows = await this.q()`
      INSERT INTO results (id, task_id, run_id, agent_id, kind, payload)
      VALUES (${id}, ${r.taskId}, ${r.runId}, ${r.agentId}, ${r.kind}, ${JSON.stringify(r.payload)}::jsonb)
      RETURNING id, task_id, run_id, agent_id, kind, payload, created_at`;
    const row = rows[0];
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      runId: String(row.run_id),
      agentId: row.agent_id as ResultRecord["agentId"],
      kind: row.kind as ResultRecord["kind"],
      payload: row.payload as ResultPayload,
      createdAt: this.ts(row.created_at),
    };
  }

  async getResultForTask(taskId: string): Promise<ResultRecord | null> {
    const rows = await this.q()`
      SELECT id, task_id, run_id, agent_id, kind, payload, created_at
      FROM results WHERE task_id = ${taskId}
      ORDER BY created_at DESC LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      runId: String(row.run_id),
      agentId: row.agent_id as ResultRecord["agentId"],
      kind: row.kind as ResultRecord["kind"],
      payload: row.payload as ResultPayload,
      createdAt: this.ts(row.created_at),
    };
  }

  async upsertAgent(spec: AgentSpec): Promise<void> {
    await this.q()`
      INSERT INTO agents (id, name, kind, description, capability, capabilities, handles_intents)
      VALUES (${spec.id}, ${spec.name}, ${spec.kind}, ${spec.description}, ${spec.capability},
              ${JSON.stringify(spec.capabilities)}::jsonb, ${JSON.stringify(spec.handlesIntents)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, kind = EXCLUDED.kind, description = EXCLUDED.description,
        capability = EXCLUDED.capability, capabilities = EXCLUDED.capabilities,
        handles_intents = EXCLUDED.handles_intents, updated_at = now()`;
  }

  private rowToAgent(r: Record<string, unknown>): RegisteredAgent {
    return {
      id: String(r.id) as RegisteredAgent["id"],
      name: String(r.name),
      kind: r.kind as RegisteredAgent["kind"],
      description: String(r.description),
      capability: r.capability as RegisteredAgent["capability"],
      capabilities: (r.capabilities as string[]) ?? [],
      handlesIntents: (r.handles_intents as RegisteredAgent["handlesIntents"]) ?? [],
      enabled: r.enabled === null || r.enabled === undefined ? true : Boolean(r.enabled),
    };
  }

  async getAgent(id: string): Promise<RegisteredAgent | null> {
    const rows = await this.q()`
      SELECT id, name, kind, description, capability, capabilities, handles_intents, enabled
      FROM agents WHERE id = ${id}`;
    return rows[0] ? this.rowToAgent(rows[0]) : null;
  }

  async listAgents(): Promise<RegisteredAgent[]> {
    const rows = await this.q()`
      SELECT id, name, kind, description, capability, capabilities, handles_intents, enabled
      FROM agents ORDER BY id ASC`;
    return rows.map((r) => this.rowToAgent(r));
  }

  async setAgentEnabled(id: string, enabled: boolean): Promise<RegisteredAgent | null> {
    const rows = await this.q()`
      UPDATE agents SET enabled = ${enabled}, updated_at = now()
      WHERE id = ${id}
      RETURNING id, name, kind, description, capability, capabilities, handles_intents, enabled`;
    return rows[0] ? this.rowToAgent(rows[0]) : null;
  }

  async saveToLibrary(rec: Omit<SavedRecord, "id" | "createdAt">): Promise<SavedRecord> {
    // Unique index on result_id makes the save idempotent: a repeated save of
    // the same result returns the existing record instead of duplicating it.
    const inserted = await this.q()`
      INSERT INTO saved_items (id, result_id, task_id, agent_id, kind, payload)
      VALUES (${randomId()}, ${rec.resultId}, ${rec.taskId}, ${rec.agentId}, ${rec.kind}, ${JSON.stringify(rec.payload)}::jsonb)
      ON CONFLICT (result_id) DO NOTHING
      RETURNING id, result_id, task_id, agent_id, kind, payload, created_at`;
    const row = inserted[0]
      ? inserted[0]
      : (
          await this.q()`
            SELECT id, result_id, task_id, agent_id, kind, payload, created_at
            FROM saved_items WHERE result_id = ${rec.resultId}`
        )[0];
    if (!row) throw new Error("saved_items insert returned no row and no existing record");
    return {
      id: String(row.id),
      resultId: String(row.result_id),
      taskId: String(row.task_id),
      agentId: row.agent_id as SavedRecord["agentId"],
      kind: row.kind as SavedRecord["kind"],
      payload: row.payload as ResultPayload,
      createdAt: this.ts(row.created_at),
    };
  }

  async listSaved(): Promise<SavedRecord[]> {
    const rows = await this.q()`
      SELECT id, result_id, task_id, agent_id, kind, payload, created_at
      FROM saved_items ORDER BY created_at DESC`;
    return rows.map((row) => ({
      id: String(row.id),
      resultId: String(row.result_id),
      taskId: String(row.task_id),
      agentId: row.agent_id as SavedRecord["agentId"],
      kind: row.kind as SavedRecord["kind"],
      payload: row.payload as ResultPayload,
      createdAt: this.ts(row.created_at),
    }));
  }

  async getSavedByResult(resultId: string): Promise<SavedRecord | null> {
    const rows = await this.q()`
      SELECT id, result_id, task_id, agent_id, kind, payload, created_at
      FROM saved_items WHERE result_id = ${resultId} LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      resultId: String(row.result_id),
      taskId: String(row.task_id),
      agentId: row.agent_id as SavedRecord["agentId"],
      kind: row.kind as SavedRecord["kind"],
      payload: row.payload as ResultPayload,
      createdAt: this.ts(row.created_at),
    };
  }

  async deleteSaved(id: string): Promise<boolean> {
    const rows = await this.q()`DELETE FROM saved_items WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  }
}

/* ----------------------------------------------------------------- factory */

let memorySingleton: MemoryStore | null = null;

/**
 * Resolve the store from the environment. DATABASE_URL present means real
 * Postgres; absent means the clearly-labeled ephemeral memory store. Never
 * throws at import time, so the app builds and serves without credentials.
 */
export function getStore(): Store {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (!memorySingleton) memorySingleton = new MemoryStore();
    return memorySingleton;
  }
  return new PostgresStore(url);
}

export function storageMode(): StorageMode {
  return process.env.DATABASE_URL ? "postgres" : "ephemeral";
}
