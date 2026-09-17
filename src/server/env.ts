/**
 * Environment status. Server-only: callers must expose booleans to the UI,
 * never the values themselves.
 */
export interface EnvVarStatus {
  name: string;
  purpose: string;
  set: boolean;
}

export interface EnvStatus {
  vars: EnvVarStatus[];
  storageMode: "postgres" | "ephemeral";
  /** True only when all three LLM vars are present; then the LLM router runs. */
  llmRouterActive: boolean;
}

export function getEnvStatus(): EnvStatus {
  const vars: EnvVarStatus[] = [
    {
      name: "DATABASE_URL",
      purpose: "Postgres connection string. Persisted mode for tasks, runs, results.",
      set: Boolean(process.env.DATABASE_URL),
    },
    {
      name: "LLM_BASE_URL",
      purpose: "OpenAI-compatible chat-completions base URL, e.g. https://api.openai.com/v1",
      set: Boolean(process.env.LLM_BASE_URL),
    },
    {
      name: "LLM_API_KEY",
      purpose: "API key for the model provider. Never logged, never rendered.",
      set: Boolean(process.env.LLM_API_KEY),
    },
    {
      name: "LLM_MODEL",
      purpose: "Model name the provider expects, e.g. gpt-4o-mini. Never hard-coded.",
      set: Boolean(process.env.LLM_MODEL),
    },
    {
      name: "AGENT_WORKSPACE",
      purpose:
        "Coding Agent sandbox directory (default ./agent-workspace). Only paths inside it are touched.",
      set: Boolean(process.env.AGENT_WORKSPACE),
    },
  ];
  return {
    vars,
    storageMode: process.env.DATABASE_URL ? "postgres" : "ephemeral",
    llmRouterActive: vars.filter((v) => v.name.startsWith("LLM_")).every((v) => v.set),
  };
}
