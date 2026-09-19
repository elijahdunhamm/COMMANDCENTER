# DealFinder Command Center

The owner's personal web dashboard for managing AI agents that run real tasks.
Type a task in natural language; the Manager Agent classifies the intent, routes
it to a specialist agent, the agent does real work with permitted tools, and a
structured result with provenance is persisted and displayed.

**This is not a mockup.** The Research Agent really calls Wikipedia and
OpenStreetMap. The DealFinder Agent really searches OpenStreetMap via the
Overpass API for nearby businesses. Scaffolded agents really decline work they cannot do. Disabled
agents really refuse tasks instead of quietly running. Statuses really reflect
what happened.

## Pages

| Route | What it shows |
| --- | --- |
| `/` | Command feed (chat), agents panel, recent task history. Research results carry a Save to library control. |
| `/tasks` | Full browsable task history (newest first, up to 200 in this view). |
| `/tasks/$taskId` | Complete timeline of one task: the command, the Manager's classification, each run with its real tool calls (request URL, HTTP status, duration), messages, and the final result. |
| `/saved` | Saved research library: save, browse with original provenance, delete (two-step confirm). Saving is idempotent per result. |
| `/agents` | Every registered agent's contract, capabilities, handled intents, live status, and the enable/disable switch. |
| `/settings` | Env var status (set/missing only, never values), storage mode, router mode, and how to change them. |

## Architecture

```
src/
  routes/index.tsx          Dashboard: command feed (chat), agents panel, task history
  routes/tasks.tsx          Full task history
  routes/tasks.$taskId.tsx  One task's complete timeline (runs, tool calls, result)
  routes/saved.tsx          Saved research library (save/browse/delete)
  routes/agents.tsx         Agent registry with enable/disable controls
  routes/settings.tsx       Env var status (set/missing only), storage mode, router mode
  components/layout.tsx     Shared header/nav + honest storage banner
  components/results.tsx    Result cards (research brief, dealfinder search, refusal, capability missing) + save control
  components/chat.tsx       Command feed renderer
  components/panels.tsx     Agents + task history panels on the dashboard
  components/status.tsx     Status badges, skeletons, time/duration helpers
  server/api.ts             Server functions (the only bridge between client and server)
  server/manager.ts         Manager Agent: interpret, classify, route, track, report; task detail/history, saved library, agent toggles
  server/model.ts           Model adapter: env-configurable LLM + deterministic fallback router
  server/agents/index.ts    Agent registry (agents are configuration) + Research Agent
  server/agents/dealfinder.ts DealFinder Agent: local-service search with provenance and honest unverified states
  server/agents/base.ts     Agent contract + honest "awaiting capability" scaffold
  server/dealfinder/parser.ts Deterministic command parser (service, specialties, radius, price cap, location)
  server/dealfinder/overpass.ts Overpass connector (timeout, retry, cache, honest outcomes)
  server/store.ts           Storage: Postgres (DATABASE_URL) or clearly-labeled ephemeral memory
  server/schema.ts          Schema (runtime source of truth; mirrored in migrations/0001_init.sql)
  server/types.ts           Agent, Task, AgentRun, ToolCall, Result, Message, SavedRecord types
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
   `working`. If that agent is disabled, the task is refused: the run is recorded
   as failed with zero tool calls, an `agent.disabled` result is persisted, and
   the feed says why. Nothing is executed behind an off switch.
4. The agent executes with permitted tools. The Research Agent calls the
   Wikipedia REST summary API and Nominatim geocoding, both key-free, both
   logged as tool calls with request URL, status, and duration. The DealFinder
   Agent geocodes an explicit place via Nominatim when needed and searches
   OpenStreetMap via Overpass (see the DealFinder section below).
5. A structured result is persisted. Every externally-sourced field carries
   provenance: source name, request URL, fetched-at timestamp. When nothing
   could be verified, the result says so instead of filling the gap.
6. The Manager reports honestly to the chat: which router ran, which agent,
   what each tool call returned, and the result kind.

Statuses (`idle / working / waiting / completed / failed / disabled`) are derived
from real runs and the registry only. Agents registered without an
implementation report `agent.capability_missing` and their tasks fail honestly;
nothing is fabricated. The Manager Agent cannot be disabled: it is the router
every task passes through, and the UI says so instead of offering the switch.

## Live activity stream (event backbone)

The orchestration loop emits a real event for every step, in the order the step
happens, and persists it through the store:

`task.queued`, `task.classified` (intent + router used), `run.started`,
`tool_call.started`, `tool_call.finished` (tool, request URL, HTTP status,
durationMs), `message.added`, `run.completed` / `run.failed`,
`task.completed` / `task.failed`.

- Agents receive a `ToolCallReporter` in their execution context; the Research
  Agent reports each Wikipedia/Nominatim call as it starts and as it finishes.
  Refused runs (disabled agent) record `run.started` + `run.failed` and zero
  tool-call events, matching what really happened.
- Persistence: Postgres mode stores events in an `events` table (BIGSERIAL
  `seq` as the stream cursor, mirrored in `migrations/0002_events.sql`), so
  history survives restarts. Ephemeral mode keeps a 2,000-entry ring buffer in
  process memory and says so. Event payloads are small and secret-free.
- Streaming: the client (`useEventStream` hook) polls the `fetchEventsSince`
  server function every 600ms with a cursor and receives exactly the events
  persisted since the last poll. **SSE was evaluated and rejected on purpose:**
  TanStack Start 1.168 has no API-file routes (`createAPIFileRoute` does not
  exist in this version) and no supported way to hold a streaming Response open
  through its server functions, which are serialized for both the dev server
  and the published Bun server. Cursor polling at 600ms delivers every step
  sub-second with zero framework risk.
- UI: the dashboard shows a compact **Live** strip (agent chips flip to
  `working` with elapsed timers the moment a run really starts; when nothing
  runs it honestly says all agents are idle) and a **Through glass** panel
  where the newest task's timeline grows in real time: classification appears
  the moment it happens, each tool call shows a spinner for exactly as long as
  the call is actually in flight, then its true status and duration. Task
  detail pages auto-refresh from the stream while their task runs and settle
  on the final timeline when it ends.
- Honesty: rows only ever show work that actually happened; nothing is
  synthesized client-side. The smoke test asserts the real event order for a
  research run, that started/finished pairs match, that refusal runs have no
  tool-call events, that every event references a task and run that really
  exist, and that cursor reads return only events after the cursor.

## Agent enable/disable

The Agents page exposes each specialist's contract (id, capability state,
implemented capabilities, handled intents, last run) and a real enable switch.
Disabling an agent:

- refuses every newly routed task immediately, with a recorded failed run and an
  explicit `agent.disabled` result naming the agent;
- never cancels a run already in flight (the status derivation shows a run that
  is genuinely executing as `working` first);
- persists in Postgres mode; in ephemeral mode the switch lives in process
  memory and resets on restart (the page says so).

## Saved research

A completed research result can be saved from the feed or the task detail page.
The library stores a copy of the payload with its provenance exactly as
fetched, the originating task id, and the agent that produced it. Saving the
same result twice returns the existing record (unique index on `result_id` in
Postgres, keyed map in ephemeral mode). Only research results are savable;
refusals and capability-missing records are not, and the control says so.

## DealFinder Agent (local-service search)

The owner's original product concept, alive as an agent: type
"Find me a low-taper barber within 10 miles under $40" and get real, nearby
businesses from OpenStreetMap, ranked by distance, with provenance and honest
unverified states.

**Parsing (deterministic, no LLM, in `src/server/dealfinder/parser.ts`):**

- Service type via an extensible keyword map (`SERVICE_TYPES`): barber and
  hairdresser first; add an entry (label + OSM tag selectors + keywords) to
  cover more services.
- Specialty phrases ("low taper", "fade", "beard trim", ...) are captured and
  displayed, and are ALWAYS marked not searchable: OpenStreetMap does not index
  hairstyles, so they can never filter or rank real results
  (`specialtySearchable: false` in the payload).
- Radius: "within N miles/km", default 10 miles (the result says whether the
  radius came from the command or the default).
- Price cap: "under $X" (also "below/less than/cheaper than", with a currency
  word when the dollar sign is absent). Used only for honesty, never for
  filtering: see prices below.
- Location: inline coordinates ("near 30.2672, -97.7431"), else an explicit
  place name ("near downtown Austin") geocoded via Nominatim, else a structured
  ask-for-location result. "Near me" is honestly unresolvable (the dashboard
  has no access to your location) and asks instead of guessing.

**Overpass usage (`src/server/dealfinder/overpass.ts`):**

- One union query per search over a radius bounding box:
  `node["shop"="hairdresser"]` + `node["shop"="beauty"]["beauty"="hairdresser"]`
  + `node["hairdresser:styling_type"="barber"]`, `[out:json][timeout:20]`,
  `out center 50` (element limit).
- GET (not POST) so the provenance request URL is openable by the owner, and an
  identifying `User-Agent` on every call.
- Built for a source that degrades: 25s client timeout per attempt and an
  in-process cache (10 min TTL, LRU-capped) so identical queries never re-hit
  the network. HTTP 200 with an empty or unparseable body counts as a failure
  (a known overpass-api.de behavior under load), not as "no results".
- Outcomes are honest and distinct: usable data (even 0 elements = genuinely
  empty area, stated with the request URL), or `sourceUnavailable` only after
  every endpoint in the chain was tried, listing each one. Nothing is papered
  over.
- Endpoint fallback order: `OVERPASS_URL` (optional) takes precedence as the
  first candidate when set, then the default
  `https://overpass-api.de/api/interpreter`, then the public mirrors
  `https://overpass.kumi.systems/api/interpreter` and
  `https://overpass.private.coffee/api/interpreter` (list is deduplicated).
  The first endpoint with a usable answer serves the whole search; the query
  is never re-sent to later endpoints once one has answered. Provenance and
  an honest one-line result note always record which endpoint actually
  served the search.

**Normalization and honesty in results:**

- Each hit: name, real OSM tag summary (category), coordinates, computed
  haversine distance (labeled computed), address, phone, website, opening hours
  when OSM has them, and an explicit "not listed" (null) when it does not.
- Hits beyond the radius are dropped (the bbox is square, the request is a
  circle), and the rest are ranked nearest first.
- Each hit carries a "why this matches" line built only from real dimensions:
  computed distance vs the radius, the OSM tags that matched, price-check
  unavailable, specialty unsearchable.
- Per-hit provenance: source ("OpenStreetMap via Overpass API"), the exact
  request URL, fetched-at. Plus a link to the OSM object itself.
- **Price is never invented.** Every hit's price is `verified: false`,
  display "not verified", with an explanation (OSM carries no price data). When
  a price cap was requested, the result states plainly that prices could not be
  checked, so the cap was not applied and no result is price-verified.
- Result kind `dealfinder.search` is rendered in the feed and task timeline as
  a comparison-ready list; the empty-area, source-unavailable, and
  ask-for-location outcomes each get their own honest panel.

Payload shape (abridged): `kind`, `command`, `service`, `specialties`,
`specialtySearchable: false`, `radiusMiles`, `radiusSource`, `maxPrice`,
`origin`, `askedForLocation`, `sourceUnavailable`, `servedFromCache`,
`overpassUrl`, `results[]`, `notes[]`; each result carries `osmType`, `osmId`,
`osmUrl`, `name`, `category`, `lat`, `lon`, `distanceMiles`, `distanceKm`,
`address`, `phone`, `website`, `openingHours`, `price`, `why`, `provenance`.

## Environment variables

| Variable | Purpose | If missing |
| --- | --- | --- |
| `DATABASE_URL` | Postgres (Neon serverless) connection string | Ephemeral in-memory mode; every page shows "Ephemeral mode: data is not persisted" |
| `LLM_BASE_URL` | OpenAI-compatible base URL, e.g. `https://api.openai.com/v1` | Deterministic fallback router is used |
| `LLM_API_KEY` | Key for the model provider | Same as above |
| `LLM_MODEL` | Model name the provider expects (e.g. `gpt-4o-mini`) | Same as above |
| `OVERPASS_URL` (optional) | Override the Overpass endpoint (default `https://overpass-api.de/api/interpreter`), e.g. a mirror while the primary is degraded | Default endpoint is used |

Secrets are read from `process.env` in server-only code, never in client code,
never in a `.env` file. The settings page shows only whether each variable is
set, never its value. The schema is applied automatically (idempotently) the
first time the Postgres store runs, including a guarded `ALTER TABLE` for
databases created before the agent enable flag existed.

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

## Mac-side agent runtime (headless CLI)

The same Manager/agent core runs headless, with no web server:

```sh
bun run agent -- "list the files in the workspace"
bun run agent --json -- "scan Hacker News for on-device AI"
```

The CLI prints an honest report: which router ran, classification, routing,
every tool call with duration and request, and the structured result. Exit
codes: 0 completed, 1 task failed or refused, 2 usage/storage error. With
`DATABASE_URL` unset, storage stays process-local (ephemeral); nothing leaves
the machine.

To route with a local model instead of the deterministic fallback, run an
OpenAI-compatible server and set the existing env vars, for example with
Ollama (free, runs on CPU):

```sh
ollama serve
ollama pull qwen2.5:1.5b-instruct-q4_K_M   # small quantized model, CPU-friendly
export LLM_BASE_URL=http://localhost:11434/v1
export LLM_API_KEY=ollama                   # Ollama ignores the value but the var must be set
export LLM_MODEL=qwen2.5:1.5b-instruct-q4_K_M
```

Model size guidance: 1.5-3B quantized models are the practical ceiling for a
2016 Intel MacBook (CPU-only, no discrete GPU); expect seconds-to-tens-of-
seconds per classification. The deterministic fallback router stays first-class:
with no LLM env vars set, everything still works and the CLI says so honestly.

The Coding Agent works only inside a sandboxed workspace directory (default
`./agent-workspace`, override with `AGENT_WORKSPACE`): list/read/write files
and whitelisted read-only commands (`ls`, `cat`, `grep`, `git status`, and
similar) under a hard timeout, with no shell. Anything outside the sandbox or
off the whitelist is refused as data (`agent.refused`), never attempted. The
Opportunity Agent scans Hacker News (Algolia API) and Wikipedia, both free and
key-free, with deterministic ranking stated in the result. Before querying, it
reduces the subject to its actual topic with deterministic prefix stripping
("business opportunities in on-device AI" searches HN for "on-device AI", not
the whole sentence; if stripping would leave only stopwords, the full subject
is queried instead), and the result records which query was really used
(`hnQuery` / `hnQuerySource`) alongside the original subject.
The Opportunity Agent also finds leads for web-design services: a command like
"find leads for web design clients in Austin" geocodes the place via the shared
Nominatim path, then queries OpenStreetMap through the shared Overpass
connector (same fallback chain, cache, and provenance) for named businesses
with a shop/amenity/craft/office/tourism tag and neither a `website` nor a
`contact:website` tag, within a radius (default 10 miles, "within N miles"
parsed like DealFinder). Leads are ranked deterministically (computed distance
ascending, ties by name), capped at 25, and each carries its OSM object URL,
address and phone only when OSM lists them, and the exact Overpass request URL
plus the endpoint that answered. The honesty framing is fixed and appears in
every result: a lead means no website listed on OpenStreetMap, a listing gap
in the map data, never a verified fact about the business. With no location,
the agent returns the same structured ask-for-location outcome DealFinder
uses; a location is never guessed.

The Research Agent resolves near-miss subjects honestly: when the direct
Wikipedia title lookup returns 404 ("Eifle Tower"), it runs one opensearch
search (key-free, the same did-you-mean correction the Wikipedia search box
uses) and, only if the hit overlaps the subject's content words, quotes that
article's summary with provenance naming both the failed slug and the article
search actually returned. A subject that matches nothing plausible stays an
honest no-summary; a wrong article is never substituted.

## Running

```sh
bun install
bun run build          # client + SSR bundles
bun run smoke          # end-to-end pipeline test with zero credentials
```

The smoke test exercises the full pipeline with no credentials: deterministic
routing of research/coding/dealfinder commands, real Wikipedia + Nominatim calls
with provenance assertions, honest failure of a scaffolded agent, task detail
assembly, the saved-research CRUD cycle (save, idempotent re-save, refusal to
save non-research, delete, honest delete-of-missing error), and the agent
disable flow (Manager un-disablable, research agent disabled, refused task with
an `agent.disabled` result and zero tool calls, re-enable, honest status
derivation afterwards), and the DealFinder Agent: parser unit checks, a real
Overpass search near Austin center coordinates with provenance and
distance assertions, price-cap honesty, the structured ask-for-location
outcome, and the event log. The dealfinder checks tolerate Overpass
degradation explicitly (they assert honesty, not uptime), and the hit-branch
checks only fire when the source actually answered.

## Design notes

One dark theme, one accent (amber), Geist Sans + Geist Mono (self-hosted via
fontsource), hairline separators instead of card piles, mono for all data
values. Status dots appear only on real semantic state and always with a text
label. Skeleton loaders for initial load, honest empty and error states
throughout, two-step destructive confirms, no em-dashes in visible copy. Per
the design-taste-frontend skill: dashboards are out of its scope, so its
applicable rules (typography, single accent, zero em-dashes, contrast, honest
states) were applied deliberately; see the session report for the Design Read
and dials.

## Known limitations

- Command execution is synchronous; the dashboard polls every 4s and shows a
  routing indicator while waiting.
- If the process dies mid-run, a persisted run can stay `working` in Postgres;
  the UI derives those stale runs as `idle` rather than faking activity, and the
  task detail says "no finish recorded".
- In ephemeral mode everything resets on restart, including enable switches
  (stated in the UI on every affected page).
- Research Agent scope is deliberately small: one summary API, one geocoder.
  Deeper multi-source synthesis is future work.
- DealFinder search is only as good as OpenStreetMap coverage in the area;
  the result says when nothing was found rather than padding the list.
  Distances are straight-line (haversine), not driving times, and prices are
  never shown as verified because OSM carries no price data.
- The tasks list page reads up to 200 tasks per view; older history stays in the
  store and remains reachable by direct task links.
