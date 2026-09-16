# DealFinder Command Center

The owner's personal web dashboard for managing AI agents that run real tasks.
Type a task in natural language; the Manager Agent classifies the intent, routes
it to a specialist agent, the agent does real work with permitted tools, and a
structured result with provenance is persisted and displayed.

**This is not a mockup.** The Research Agent really calls Wikipedia and
OpenStreetMap. Scaffolded agents really decline work they cannot do. Statuses
really reflect what happened.

## Architecture

```
src/
  routes/index.tsx          Dashboard: command feed (chat), agents panel, task history
  routes/settings.tsx       Env var status (set/missing only), storage mode, router mode
  server/api.ts             Server functions (the only bridge between client and server)
  server/manager.ts         Manager Agent: interpret, classify, route, track, report
  server/model.ts           Model adapter: env-configurable LLM + deterministic fallback router
  server/agents/index.ts    Agent registry (agents are configuration) + Research Agent
  server/agents/base.ts     Agent contract + honest "awaiting capability" scaffold
  server/store.ts           Storage: Postgres (DATABASE_URL) or clearly-labeled ephemeral memory
  server/schema.ts          Schema (runtime source of truth; mirrored in migrations/0001_init.sql)
  server/types.ts           Agent, Task, AgentRun, ToolCall, Result, Message types
scripts/smoke.ts            End-to-end pipeline test, zero credentials
```

Orchestration, secrets, and storage live server-side only. The heavy modules are
dynamically imported inside server-function handlers, so they never reach the
client bundle (the build emits them as separate server chunks).

## Pipeline

1. Owner types a command in the chat. It is persisted as a task (status `queued`)
   and a user message.
2. The Manager classifies intent:
   - `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` all set: an OpenAI-compatible
     `/chat/completions` call with a JSON-output prompt classifies intent and
     extracts the subject. On any failure it falls back to rules and says so.
   - Otherwise: a deterministic keyword router classifies into
     `research | coding | opportunity | dealfinder` and extracts the subject.
3. The Manager routes to the registered agent for that intent and marks the task
   `working`.
4. The agent executes with permitted tools. The Research Agent (the one
   functional capability) calls the Wikipedia REST summary API and Nominatim
   geocoding, both key-free, both logged as tool calls with request URL, status,
   and duration.
5. A structured result is persisted. Every externally-sourced field carries
   provenance: source name, request URL, fetched-at timestamp. When nothing
   could be verified, the result says so instead of filling the gap.
6. The Manager reports honestly to the chat: which router ran, which agent,
   what each tool call returned, and the result kind.

Statuses (`idle / working / waiting / completed / failed`) are derived from real
runs only. Agents registered without an implementation report
`agent.capability_missing` and their tasks fail honestly; nothing is fabricated.

## Environment variables

| Variable | Purpose | If missing |
| --- | --- | --- |
| `DATABASE_URL` | Postgres (Neon serverless) connection string | Ephemeral in-memory mode; the UI shows "Ephemeral mode: data is not persisted" |
| `LLM_BASE_URL` | OpenAI-compatible base URL, e.g. `https://api.openai.com/v1` | Deterministic fallback router is used |
| `LLM_API_KEY` | Key for the model provider | Same as above |
| `LLM_MODEL` | Model name the provider expects (e.g. `gpt-4o-mini`) | Same as above |

Secrets are read from `process.env` in server-only code, never in client code,
never in a `.env` file. The settings page shows only whether each variable is
set, never its value. The schema is applied automatically (idempotently) the
first time the Postgres store runs.

## Switching model provider

The adapter speaks OpenAI-compatible chat completions and never hard-codes a
model. Point `LLM_BASE_URL` at any provider that implements it (OpenAI, an Azure
gateway, OpenRouter, a local vLLM or Ollama server), set `LLM_API_KEY`, and set
`LLM_MODEL` to a model the provider recognizes. No code changes. If a call fails
or returns an unparseable intent, the deterministic fallback router takes over
and the feed says so.

## Adding an agent

1. Add a spec to `AGENT_SPECS` in `src/server/agents/index.ts`: id, name, the
   intents it handles, and `capability: "awaiting"` until real work exists.
2. Implement `execute(task, ctx)` (see `src/server/agents/base.ts` for the
   contract): use permitted tools, return a structured result with provenance
   on every external field, and tool calls for the run log.
3. Register it in the `AGENTS` map keyed by intent.

The Manager picks it up automatically; it appears in the Agents panel. Until a
capability is real, leave the agent as `awaiting`: it declines tasks honestly
instead of producing fake output.

## Running

```sh
bun install
bun run build          # client + SSR bundles
bun run smoke          # end-to-end pipeline test with zero credentials
```

The smoke test routes a research command through the full pipeline (real
Wikipedia + Nominatim calls), asserts provenance on the result, and proves a
scaffolded agent fails honestly.

## Design notes

One dark theme, one accent (amber), Geist Sans + Geist Mono (self-hosted via
fontsource), hairline separators instead of card piles, mono for all data
values. Status dots appear only on real semantic state and always with a text
label. Skeleton loaders for initial load, honest empty and error states
throughout. Per the design-taste-frontend skill: dashboards are out of its
scope, so its applicable rules (typography, single accent, zero em-dashes,
contrast, honest states) were applied deliberately; see the session report for
the Design Read and dials.

## Known limitations

- Command execution is synchronous; the dashboard polls every 4s and shows a
  routing indicator while waiting.
- If the process dies mid-run, a persisted run can stay `working` in Postgres;
  the UI derives those stale runs as `idle` rather than faking activity.
- In ephemeral mode everything resets on restart (this is stated in the UI).
- Research Agent scope is deliberately small: one summary API, one geocoder.
  Deeper multi-source synthesis is future work.
