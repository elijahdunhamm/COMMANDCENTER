import type {
  AgentSpec,
  PlaceSection,
  Provenance,
  ResearchBriefResult,
  SummarySection,
  ToolCall,
} from "../types";
import type { Agent, AgentExecution, ExecutionContext } from "./base";
import { dealfinderAgent } from "./dealfinder";
import { codingAgent } from "./coding";
import { opportunityAgent } from "./opportunity";
import { OPEN_DATA_UA, timedFetchJson } from "../tools/fetch";

/**
 * Registry: agents are configuration. Adding an agent means adding a spec
 * here (plus an implementation with at least one real capability for it to
 * report "ready" rather than "awaiting").
 */

const researchSpec: AgentSpec = {
  id: "research",
  name: "Research Agent",
  kind: "specialist",
  description: "Looks up facts and places using permitted, key-free open APIs.",
  capability: "ready",
  capabilities: [
    "Wikipedia REST page summary (no key required)",
    "Nominatim geocoding via OpenStreetMap (no key required)",
    "Provenance (source, URL, fetched-at) on every returned field",
  ],
  handlesIntents: ["research"],
};

const codingSpec = codingAgent.spec;
const opportunitySpec = opportunityAgent.spec;

/* dealfinderSpec is owned by ./dealfinder (the real implementation). */

const managerSpec: AgentSpec = {
  id: "manager",
  name: "Manager Agent",
  kind: "manager",
  description: "Interprets commands, classifies intent, routes tasks, tracks status.",
  capability: "ready",
  capabilities: [
    "Intent classification (LLM when configured, deterministic rules otherwise)",
    "Task routing to registered specialist agents",
    "Run and status tracking with honest failure reporting",
  ],
  handlesIntents: [],
};

/* ------------------------------------------------------- research (ready) */

interface WikiSummary {
  title?: string;
  extract?: string;
  type?: string;
  content_urls?: { desktop?: { page?: string } };
}

interface NominatimHit {
  display_name?: string;
  lat?: string;
  lon?: string;
  category?: string;
  type?: string;
  osm_type?: string;
  osm_id?: number;
}

export const researchAgent: Agent = {
  spec: researchSpec,
  async execute(task, ctx: ExecutionContext): Promise<AgentExecution> {
    const subject = (ctx.subject || task.command).trim();
    const reporter = ctx.reporter;
    const notes: string[] = [];
    const toolCalls: ToolCall[] = [];

    // Tool 1: Wikipedia REST summary (permitted, no key).
    const wikiSlug = encodeURIComponent(subject.replace(/\s+/g, "_"));
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${wikiSlug}`;
    const wiki = await timedFetchJson("wikipedia.summary", wikiUrl, { "user-agent": OPEN_DATA_UA }, 10000, reporter);
    toolCalls.push(wiki.call);

    let summary: SummarySection | null = null;
    if (wiki.json && typeof wiki.json === "object") {
      const w = wiki.json as WikiSummary;
      const provenance: Provenance = {
        source: "Wikipedia REST API (page summary)",
        url: wikiUrl,
        fetchedAt: new Date().toISOString(),
      };
      if (w.type === "disambiguation") {
        notes.push(
          `Wikipedia returned a disambiguation page for "${subject}", so no single summary is quoted.`,
        );
        summary = { text: null, title: w.title ?? null, articleUrl: null, provenance };
      } else if (w.extract) {
        summary = {
          text: w.extract,
          title: w.title ?? null,
          articleUrl: w.content_urls?.desktop?.page ?? null,
          provenance,
        };
      } else {
        notes.push(`Wikipedia matched the page but returned no summary text (checked ${wikiUrl}).`);
        summary = { text: null, title: w.title ?? null, articleUrl: null, provenance };
      }
    } else {
      notes.push(
        wiki.call.ok
          ? `No Wikipedia summary found for "${subject}" (checked ${wikiUrl}).`
          : `Wikipedia request failed (${wiki.call.status ?? wiki.call.error ?? "unknown error"}): ${wikiUrl}`,
      );
    }

    // Tool 2: Nominatim geocoding (permitted, no key; identifying UA per policy).
    const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(subject)}&format=jsonv2&limit=1`;
    const nom = await timedFetchJson("nominatim.search", nomUrl, { "user-agent": OPEN_DATA_UA }, 10000, reporter);
    toolCalls.push(nom.call);

    let place: PlaceSection | null = null;
    if (Array.isArray(nom.json) && nom.json.length > 0) {
      const hit = nom.json[0] as NominatimHit;
      const lat = hit.lat != null ? Number(hit.lat) : null;
      const lon = hit.lon != null ? Number(hit.lon) : null;
      if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
        place = {
          displayName: hit.display_name ?? null,
          lat,
          lon,
          category: hit.category ?? null,
          osmUrl:
            hit.osm_type && hit.osm_id != null
              ? `https://www.openstreetmap.org/${hit.osm_type}/${hit.osm_id}`
              : null,
          provenance: {
            source: "OpenStreetMap Nominatim",
            url: nomUrl,
            fetchedAt: new Date().toISOString(),
          },
        };
      } else {
        notes.push(`Nominatim matched a result but returned unusable coordinates (checked ${nomUrl}).`);
      }
    } else {
      notes.push(
        nom.call.ok
          ? `No geocoding match for "${subject}" (checked ${nomUrl}); non-place topics commonly have none.`
          : `Nominatim request failed (${nom.call.status ?? nom.call.error ?? "unknown error"}): ${nomUrl}`,
      );
    }

    const gotSomething = Boolean(summary?.text || place);
    const allCallsFailed = toolCalls.length > 0 && toolCalls.every((c) => !c.ok);

    const result: ResearchBriefResult = {
      kind: "research.brief",
      subject,
      summary,
      place,
      notes,
    };

    const parts: string[] = [];
    parts.push(
      summary?.text
        ? `Wikipedia summary retrieved (${summary.provenance.source}).`
        : "No Wikipedia summary.",
    );
    parts.push(place ? `Geocoded via OpenStreetMap.` : "No geocode match.");

    return {
      status: !gotSomething && allCallsFailed ? "failed" : "completed",
      result,
      toolCalls,
      error: !gotSomething && allCallsFailed ? "all permitted sources were unreachable" : null,
      summary: parts.join(" "),
    };
  },
};

/* coding and opportunity are real implementations: see ./coding and
   ./opportunity. awaitingAgent (base.ts) remains the honest pattern for any
   future registered-but-unimplemented agent. */

/* -------------------------------------------------------------- registry */

export const AGENT_SPECS: AgentSpec[] = [
  managerSpec,
  researchSpec,
  codingSpec,
  opportunitySpec,
  dealfinderAgent.spec,
];

export const AGENTS: Record<string, Agent> = {
  research: researchAgent,
  coding: codingAgent,
  opportunity: opportunityAgent,
  dealfinder: dealfinderAgent,
};

export function resolveAgentByIntent(intent: string): Agent {
  return AGENTS[intent] ?? researchAgent;
}

export { managerSpec };
