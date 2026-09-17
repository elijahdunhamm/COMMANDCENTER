import type {
  AgentSpec,
  PlaceSection,
  Provenance,
  ResearchBriefResult,
  ResearchSummaryFallback,
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
    "Wikipedia search fallback on a 404 title lookup via the opensearch API (no key required; a summary is only quoted from an article search actually returned)",
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

/**
 * Function words excluded from the plausibility check. A candidate article
 * must overlap the subject on content words, not on filler.
 */
const WIKI_STOPWORDS = new Set([
  "the", "a", "an", "in", "for", "around", "near", "on", "of", "and", "or",
  "to", "with", "within", "about", "at", "by", "from", "into", "over", "me",
  "my", "our", "us", "your", "it", "its", "this", "that", "is", "are", "was",
  "were", "be", "been", "history", "brief", "tell", "look", "info",
]);

/** Content tokens of a subject: words that could plausibly anchor a match. */
export function subjectContentTokens(subject: string): string[] {
  return subject
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !WIKI_STOPWORDS.has(t));
}

/**
 * Decides whether a Wikipedia search hit is a plausible match for the subject,
 * deterministically: at least half of the subject's content tokens (and at
 * least one) must appear in the candidate's title or description. Typos pass
 * through the OTHER tokens ("Eifel Tower" matches on "tower"); genuinely
 * absent nonsense matches on nothing and is rejected, so a wrong article is
 * never substituted for a topic that does not exist. Exact substring checks:
 * no fuzzy matching.
 */
export function isPlausibleWikiHit(
  subject: string,
  title: string | null,
  description: string | null,
): boolean {
  const tokens = subjectContentTokens(subject);
  if (tokens.length === 0) return false;
  const hay = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  const hits = tokens.filter((t) => hay.includes(t)).length;
  const required = tokens.length === 1 ? 1 : Math.ceil(tokens.length / 2);
  return hits >= required;
}

/** Picks the first plausible hit from a Wikipedia opensearch response
 *  ([query, [titles], [descriptions], [urls]] with parallel arrays), or null. */
export function pickPlausibleOpenSearchHit(
  subject: string,
  json: unknown,
): { title: string; url: string | null } | null {
  if (!Array.isArray(json) || json.length < 2) return null;
  const titles = Array.isArray(json[1]) ? json[1] : [];
  const descriptions = Array.isArray(json[2]) ? json[2] : [];
  const urls = Array.isArray(json[3]) ? json[3] : [];
  for (let i = 0; i < titles.length; i += 1) {
    const title = typeof titles[i] === "string" && titles[i] ? titles[i] : null;
    if (!title) continue;
    const description =
      typeof descriptions[i] === "string" && descriptions[i] ? descriptions[i] : null;
    const url = typeof urls[i] === "string" && urls[i] ? urls[i] : null;
    if (isPlausibleWikiHit(subject, title, description)) {
      return { title, url };
    }
  }
  return null;
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
    let summaryFallback: ResearchSummaryFallback | null = null;
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
    } else if (wiki.call.status === 404) {
      // Fallback: the subject as a title does not exist. Search Wikipedia
      // (opensearch action API, permitted and key-free: it applies the same
      // did-you-mean correction the Wikipedia search box uses) and only quote
      // a hit when the match is plausible. A nonsense subject matches nothing
      // plausible and stays an honest no-summary, never a substituted article.
      const searchUrl =
        `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(subject)}` +
        `&limit=1&format=json&formatversion=2`;
      const search = await timedFetchJson("wikipedia.search", searchUrl, { "user-agent": OPEN_DATA_UA }, 10000, reporter);
      toolCalls.push(search.call);
      const candidate = search.call.ok ? pickPlausibleOpenSearchHit(subject, search.json) : null;
      if (candidate) {
        const fallbackSlug = encodeURIComponent(candidate.title.replace(/\s+/g, "_"));
        const fallbackUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${fallbackSlug}`;
        const fallback = await timedFetchJson("wikipedia.summary", fallbackUrl, { "user-agent": OPEN_DATA_UA }, 10000, reporter);
        toolCalls.push(fallback.call);
        if (fallback.json && typeof fallback.json === "object") {
          const w = fallback.json as WikiSummary;
          const provenance: Provenance = {
            source: "Wikipedia REST API (page summary, found via search fallback)",
            url: fallbackUrl,
            fetchedAt: new Date().toISOString(),
          };
          if (w.type === "disambiguation") {
            notes.push(
              `The direct lookup for "${subject}" returned 404 (checked ${wikiUrl}); Wikipedia search matched ` +
                `"${candidate.title}", but that is a disambiguation page, so no single summary is quoted.`,
            );
          } else if (w.extract) {
            summary = {
              text: w.extract,
              title: w.title ?? candidate.title,
              articleUrl: w.content_urls?.desktop?.page ?? candidate.url ?? null,
              provenance,
            };
            summaryFallback = {
              failedSummaryUrl: wikiUrl,
              searchUrl,
              articleTitle: candidate.title,
              articleUrl: w.content_urls?.desktop?.page ?? candidate.url ?? fallbackUrl,
            };
            notes.push(
              `The direct summary lookup for "${subject}" returned 404 (checked ${wikiUrl}). Wikipedia search ` +
                `matched the article "${candidate.title}", and the summary above was fetched from ${fallbackUrl}. ` +
                `Nothing was quoted from an article that search did not actually return.`,
            );
          } else {
            notes.push(
              `The direct lookup for "${subject}" returned 404 (checked ${wikiUrl}); Wikipedia search matched ` +
                `"${candidate.title}", but that page returned no summary text (checked ${fallbackUrl}).`,
            );
          }
        } else {
          notes.push(
            `The direct lookup for "${subject}" returned 404 (checked ${wikiUrl}); Wikipedia search matched ` +
              `"${candidate.title}", but its summary request failed (${fallback.call.status ?? fallback.call.error ?? "unknown error"}): ${fallbackUrl}`,
          );
        }
      } else {
        notes.push(
          search.call.ok
            ? `No Wikipedia summary found for "${subject}" (checked ${wikiUrl}); a Wikipedia search also found ` +
              `no plausible article, so nothing was substituted.`
            : `The direct lookup for "${subject}" returned 404 (checked ${wikiUrl}), and the Wikipedia search ` +
              `request failed (${search.call.status ?? search.call.error ?? "unknown error"}): ${searchUrl}`,
        );
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
      summaryFallback,
      place,
      notes,
    };

    const parts: string[] = [];
    parts.push(
      summary?.text
        ? summaryFallback
          ? `Wikipedia summary retrieved via search fallback (${summary.provenance.source}).`
          : `Wikipedia summary retrieved (${summary.provenance.source}).`
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
