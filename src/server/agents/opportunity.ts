import type {
  AgentSpec,
  DealFinderOrigin,
  OpportunityLead,
  OpportunityLeadsResult,
  OpportunityScanResult,
  OpportunityStory,
  Provenance,
  SummarySection,
  Task,
  ToolCall,
} from "../types";
import type { OverpassElement, OverpassSelector } from "../dealfinder/overpass";
import type { Agent, AgentExecution, ExecutionContext } from "./base";
import { OPEN_DATA_UA, timedFetchJson } from "../tools/fetch";
import { parseDealfinderQuery } from "../dealfinder/parser";
import {
  haversineMiles,
  searchOverpass,
} from "../dealfinder/overpass";
import { buildAddress, geocodePlace } from "./dealfinder";

/**
 * Opportunity Agent: two real capabilities, both with permitted, key-free
 * public APIs only.
 *
 * 1. Topic scan: Hacker News via the Algolia Search API plus a Wikipedia REST
 *    page summary, ranked deterministically (points descending, newest first).
 *
 * 2. Lead finder ("find leads for X in Y"): named, categorized businesses
 *    whose OpenStreetMap record lists no website (neither a website nor a
 *    contact:website tag), found via the shared Nominatim geocoder and the
 *    shared Overpass connector (fallback chain, cache, provenance). A lead
 *    reports a listing gap in the map data, never a verified fact about the
 *    business, and every result states that framing.
 *
 * Ranking is fully deterministic and stated in the result. Every number comes
 * straight from an API response or a computed haversine distance; nothing is
 * scored, weighted, or invented.
 */

const opportunitySpec: AgentSpec = {
  id: "opportunity",
  name: "Opportunity Agent",
  kind: "specialist",
  description:
    "Scans Hacker News (Algolia API) and Wikipedia for a topic, and finds local businesses whose OpenStreetMap record lists no website as leads; deterministic, sourced results.",
  capability: "ready",
  capabilities: [
    "Hacker News search via the Algolia API (free, no key required)",
    "Wikipedia REST page summary for topic context (no key required)",
    "Lead finder: named businesses with no website listed on OpenStreetMap, via the shared Nominatim geocoder and Overpass connector (no key required)",
    "Deterministic ranking stated in every result (points desc for scans, computed distance asc for leads)",
    "Provenance (source, URL, fetched-at) on every story, lead, and section",
  ],
  handlesIntents: ["opportunity"],
};

export const RANKING_RULE = "points descending, ties broken by newest first (no model scoring)";

const HN_HITS_PER_PAGE = 20;

/* ------------------------------------------- subject-to-topic extraction */

/**
 * Function words only. If stripping the leading phrasing leaves nothing but
 * these, the extraction is rejected and the full subject is queried instead.
 */
const TOPIC_STOPWORDS = new Set([
  "a", "an", "the", "in", "for", "around", "near", "on", "of", "and", "or",
  "to", "with", "within", "about", "at", "by", "from", "into", "over", "me",
  "my", "our", "us", "your", "it", "its", "this", "that", "is", "are", "new",
]);

/**
 * Leading phrasings that mean "query this topic", applied repeatedly. Pure
 * string ops: no model, no fuzzy matching. More specific patterns come first
 * so "scan Hacker News for X" loses the whole prefix, not just "scan".
 */
const TOPIC_PREFIX_PATTERNS: RegExp[] = [
  /^(?:scan|search)\s+(?:hacker\s?news|hn)\s+(?:for|about|on)\s+/i,
  /^(?:scan|search)\s+(?:for|about)\s+/i,
  /^find\s+(?:me\s+)?(?:business\s+)?(?:opportunit(?:y|ies)|leads?|market\s+gaps?|business\s+ideas?|niches?)\s+(?:in|for|around|near|within|about|on)\s+/i,
  /^(?:business\s+)?(?:opportunit(?:y|ies)|leads?|market\s+gaps?|business\s+ideas?|niches?)\s+(?:in|for|around|near|within|about|on)\s+/i,
];

/** The shape extractSearchTopic returns. `extracted` says whether the topic
 *  differs from the subject the agent was handed (honest provenance). */
export interface ExtractedTopic {
  topic: string;
  extracted: boolean;
}

/**
 * Reduces a task subject like "business opportunities in on-device AI" to the
 * actual searchable topic "on-device AI" with deterministic prefix stripping.
 * Guardrail: when stripping would leave an empty or stopword-only string, the
 * full subject is kept and extracted=false is returned, so the agent never
 * queries a meaningless term.
 */
export function extractSearchTopic(subject: string): ExtractedTopic {
  const original = subject.trim();
  let s = original
    .replace(/^(?:please\s+)?(?:can you\s+|could you\s+)?/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  for (let i = 0; i < 4; i += 1) {
    let changed = false;
    for (const re of TOPIC_PREFIX_PATTERNS) {
      const next = s.replace(re, "").trim();
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  s = s.replace(/^(?:the|a|an)\s+/i, "").replace(/\s+/g, " ").trim();
  const tokens = s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const stopwordOnly = tokens.length === 0 || tokens.every((t) => TOPIC_STOPWORDS.has(t));
  if (s === "" || stopwordOnly || s.toLowerCase() === original.toLowerCase()) {
    return { topic: original, extracted: false };
  }
  return { topic: s, extracted: true };
}

/* ------------------------------------------------- parsing (pure, testable) */

/** Minimal shape actually read from the Algolia /search response. */
interface AlgoliaHit {
  objectID?: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  story_url?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at?: string;
  author?: string | null;
}

/** Normalizes one Algolia hit to a real-data story record, or null when the
 *  hit is not a usable story (no id, no title, or unparsable). */
export function parseHnHit(hit: AlgoliaHit): Omit<OpportunityStory, "rank" | "provenance"> | null {
  const objectId = typeof hit.objectID === "string" ? hit.objectID : null;
  const title =
    (typeof hit.title === "string" && hit.title.trim() && hit.title) ||
    (typeof hit.story_title === "string" && hit.story_title.trim() && hit.story_title) ||
    null;
  if (!objectId || !title) return null;
  const points = typeof hit.points === "number" && Number.isFinite(hit.points) ? hit.points : null;
  const numComments =
    typeof hit.num_comments === "number" && Number.isFinite(hit.num_comments) ? hit.num_comments : null;
  const createdAt = typeof hit.created_at === "string" && !Number.isNaN(Date.parse(hit.created_at))
    ? hit.created_at
    : null;
  const url =
    (typeof hit.url === "string" && hit.url.trim() && hit.url) ||
    (typeof hit.story_url === "string" && hit.story_url.trim() && hit.story_url) ||
    null;
  return {
    objectId,
    title,
    url,
    hnUrl: `https://news.ycombinator.com/item?id=${encodeURIComponent(objectId)}`,
    points: points ?? 0,
    numComments: numComments ?? 0,
    createdAt: createdAt ?? "",
    author: typeof hit.author === "string" && hit.author ? hit.author : null,
  };
}

/** Deterministic ranking: points desc, then createdAt desc (newest first).
 *  Stories without a parsable created_at sort after those that have one at the
 *  same points level. Ranks are 1-based positions in this ordering. */
export function rankStories(
  stories: Omit<OpportunityStory, "rank" | "provenance">[],
): Omit<OpportunityStory, "provenance">[] {
  const sorted = [...stories].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const ta = a.createdAt ? Date.parse(a.createdAt) : Number.NEGATIVE_INFINITY;
    const tb = b.createdAt ? Date.parse(b.createdAt) : Number.NEGATIVE_INFINITY;
    if (tb !== ta) return tb - ta;
    return a.objectId.localeCompare(b.objectId); // total order, no coin flips
  });
  return sorted.map((s, i) => ({ ...s, rank: i + 1 }));
}

/* ------------------------------------------------------------ lead finder */

/** Hard cap on leads listed per result. The fetch pulls more from Overpass
 *  so the cap can be applied AFTER distance filtering and ranking. */
export const LEAD_CAP = 25;
/** Element limit for the Overpass fetch (`out center N`). Higher than the cap
 *  on purpose: ranking happens over everything fetched, then the cap applies. */
export const LEAD_FETCH_LIMIT = 100;

export const LEADS_RANKING_RULE =
  "distance ascending (computed), ties broken by name (no model scoring)";

/** The honesty framing carried by EVERY opportunity.leads result. The phrase
 *  is deliberate: leads show "no website listed on OpenStreetMap", which is a
 *  listing gap in the map data, never a verified fact about the business. */
export const LEADS_HONESTY_NOTE =
  "A lead here means the OpenStreetMap record shows no website listed on OpenStreetMap (neither a website nor a contact:website tag). " +
  "That is a listing gap in the map data, not a verified fact about the business: OpenStreetMap can be incomplete, and the business may have a website that OpenStreetMap does not record. Verify before relying on any lead.";

/** Commands that mean the lead finder, not the HN topic scan. An explicit
 *  Hacker News scan ("scan HN for leads about X") stays a topic scan. */
const HN_SCAN_RE = /\b(?:scan|search)\s+(?:hacker\s?news|hn)\b/i;
const LEADS_PHRASING_RE =
  /\b(?:find|get|show|list|give\s+me|gather|collect)(?:\s+me)?\s+(?:business\s+)?leads?\b|\bleads?\s+(?:for|in|near|around)\b/i;

export function isLeadCommand(command: string): boolean {
  if (HN_SCAN_RE.test(command)) return false;
  return LEADS_PHRASING_RE.test(command);
}

/** Captures the "for X" phrase (who the leads are for) for display only. */
const AUDIENCE_RE = /\bleads?\s+for\s+(.+?)(?=\s+(?:in|near|around|within|close to)\b|$|[,.!?;])/i;

export function extractAudience(command: string): string | null {
  const m = command.match(AUDIENCE_RE);
  if (!m) return null;
  const s = m[1].trim().replace(/\s+/g, " ");
  return s.length >= 2 ? s : null;
}

/** Category keys the lead filter searches (the brief's tag set). */
export const LEAD_CATEGORY_KEYS = ["shop", "amenity", "craft", "office", "tourism"] as const;

/**
 * The Overpass selectors for lead finding: a named element carrying any of
 * the category keys and neither a website nor a contact:website tag. The
 * missing-website exclusion lives IN the query (the connector emits [!"key"]
 * negations) and is re-checked per element, so a connector serving slightly
 * stale or differently-filtered data can never leak a website-carrying
 * business into the leads.
 */
export function leadSelectors(): OverpassSelector[] {
  return LEAD_CATEGORY_KEYS.map((key) => ({
    key,
    requireKeys: ["name"],
    excludeKeys: ["website", "contact:website"],
  }));
}

export interface LeadFilterSkips {
  duplicates: number;
  noName: number;
  hasWebsiteTag: number;
  noCategory: number;
  noCoords: number;
  outsideRadius: number;
}

export interface LeadFilterOutcome {
  leads: Omit<OpportunityLead, "provenance">[];
  skips: LeadFilterSkips;
}

/**
 * Turns raw Overpass elements into lead records. Pure and fixture-testable:
 * requires a non-empty name tag, at least one category tag, no website or
 * contact:website tag, usable coordinates, and a computed distance inside the
 * radius (the Overpass bbox is square; the search area is a circle). Every
 * exclusion is counted so the result can say what was left out and why.
 * Phone comes from the OSM phone or contact:phone tag ONLY (contact:mobile
 * and similar are not collected).
 */
export function filterLeadElements(
  elements: OverpassElement[],
  origin: { lat: number; lon: number },
  radiusMiles: number,
): LeadFilterOutcome {
  const skips: LeadFilterSkips = {
    duplicates: 0, noName: 0, hasWebsiteTag: 0, noCategory: 0, noCoords: 0, outsideRadius: 0,
  };
  const leads: Omit<OpportunityLead, "provenance">[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) {
      skips.duplicates++;
      continue;
    }
    seen.add(key);
    const name = el.tags["name"]?.trim() ?? "";
    if (!name) {
      skips.noName++;
      continue;
    }
    const website = el.tags["website"] ?? el.tags["contact:website"];
    if (website && website.trim()) {
      skips.hasWebsiteTag++;
      continue;
    }
    const categoryParts: string[] = [];
    for (const k of LEAD_CATEGORY_KEYS) {
      const v = el.tags[k]?.trim();
      if (v) categoryParts.push(`${k}=${v}`);
    }
    if (categoryParts.length === 0) {
      skips.noCategory++;
      continue;
    }
    const lat = el.center?.lat ?? el.lat;
    const lon = el.center?.lon ?? el.lon;
    if (lat == null || lon == null) {
      skips.noCoords++;
      continue;
    }
    const distanceMiles = haversineMiles(origin.lat, origin.lon, lat, lon);
    if (distanceMiles > radiusMiles + 0.0001) {
      skips.outsideRadius++;
      continue;
    }
    leads.push({
      osmType: el.type,
      osmId: el.id,
      osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      name,
      category: categoryParts.join(", "),
      address: buildAddress(el.tags),
      phone: el.tags["phone"]?.trim() || el.tags["contact:phone"]?.trim() || null,
      lat,
      lon,
      distanceMiles,
      distanceKm: distanceMiles * 1.609344,
    });
  }
  return { leads, skips };
}

/** Deterministic ranking: distance ascending, ties broken by name, then by
 *  OSM object identity so the order is total (no coin flips). */
export function rankLeads(
  leads: Omit<OpportunityLead, "provenance">[],
): Omit<OpportunityLead, "provenance">[] {
  return [...leads].sort((a, b) => {
    if (a.distanceMiles !== b.distanceMiles) return a.distanceMiles - b.distanceMiles;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return `${a.osmType}/${a.osmId}`.localeCompare(`${b.osmType}/${b.osmId}`);
  });
}

function emptyLeadsResult(command: string, subject: string, audience: string | null): OpportunityLeadsResult {
  return {
    kind: "opportunity.leads",
    command,
    subject,
    audience,
    radiusMiles: 10,
    radiusSource: "default",
    origin: null,
    askedForLocation: false,
    sourceUnavailable: false,
    servedFromCache: false,
    overpassUrl: null,
    servedBy: null,
    fallbackUsed: false,
    elementsFetched: null,
    leadCap: LEAD_CAP,
    leads: [],
    rankingRule: LEADS_RANKING_RULE,
    websiteListingNote: LEADS_HONESTY_NOTE,
    notes: [],
  };
}

/** Format a radius the way results display it (0 decimals on whole miles). */
function radiusLabel(miles: number): string {
  return miles.toFixed(miles % 1 === 0 ? 0 : 1);
}

/**
 * Lead-finder execution. Location handling mirrors the DealFinder Agent
 * exactly: coordinates in the command, else geocode an explicit place via the
 * shared Nominatim path, else an honest structured ask-for-location. Never a
 * guessed search area. The Overpass search reuses the shared connector with
 * its fallback chain, cache, and provenance.
 */
async function executeLeadFinder(task: Task, ctx: ExecutionContext): Promise<AgentExecution> {
  const command = task.command;
  const subject = (ctx.subject || command).trim();
  const reporter = ctx.reporter;
  const notes: string[] = [];
  const toolCalls: ToolCall[] = [];

  // The DealFinder parser supplies the shared pieces (radius, coordinates,
  // place, self-location detection); service types, specialties, and price
  // caps are irrelevant to lead finding and are never applied.
  const parsed = parseDealfinderQuery(command);
  const radiusMiles =
    parsed.radius.unit === "km" ? parsed.radius.value * 0.621371 : parsed.radius.value;
  const audience = extractAudience(command);

  const result = emptyLeadsResult(command, subject, audience);
  result.radiusMiles = radiusMiles;
  result.radiusSource = parsed.radius.source;

  if (audience) {
    notes.push(
      `The phrase "for ${audience}" describes who the leads are for. OpenStreetMap cannot be searched by client fit or demand, ` +
        `so it did not filter or rank anything: the query lists businesses in the area that match the tagging filter, whatever their industry.`,
    );
  }
  if (parsed.maxPrice) {
    notes.push(
      `A price cap was mentioned, but prices do not exist in OpenStreetMap data, so no price filter was applied and no price appears in this result.`,
    );
  }
  if (parsed.specialties.length > 0) {
    notes.push(
      `The phrase(s) "${parsed.specialties.join('", "')}" cannot be searched in OpenStreetMap and did not filter or rank anything.`,
    );
  }

  // Resolve the search origin: coordinates, else geocode, else ask. Never guess.
  let origin: DealFinderOrigin | null = null;
  if (parsed.coords) {
    origin = {
      kind: "coordinates",
      label: `${parsed.coords.lat}, ${parsed.coords.lon} (supplied in the command)`,
      lat: parsed.coords.lat,
      lon: parsed.coords.lon,
      provenance: null,
    };
  } else if (parsed.place) {
    const geo = await geocodePlace(parsed.place, reporter);
    toolCalls.push(geo.call);
    if (geo.origin) {
      origin = geo.origin;
    } else {
      notes.push(
        geo.call.ok
          ? `The place "${parsed.place}" could not be geocoded via OpenStreetMap Nominatim (no match; checked ${geo.call.request}).`
          : `Geocoding for "${parsed.place}" failed (${geo.call.status ?? geo.call.error ?? "unknown error"}; checked ${geo.call.request}).`,
      );
    }
  } else if (parsed.unresolvableSelfLocation) {
    notes.push(
      `The command says "near me", but this dashboard has no access to your location, so "me" could not be resolved. ` +
        `Provide a place name (e.g. "find leads for web design clients in Austin") or coordinates (e.g. "find leads near 30.2672, -97.7431").`,
    );
  } else {
    notes.push(
      `No location could be found in the command, so no search area could be determined. ` +
        `Provide a place name (e.g. "find leads for web design clients in Austin") or coordinates (e.g. "find leads near 30.2672, -97.7431").`,
    );
  }

  if (!origin) {
    result.askedForLocation = true;
    result.notes = notes;
    const asked =
      parsed.unresolvableSelfLocation || parsed.place
        ? `The location could not be resolved, so the Opportunity Agent is asking for one instead of guessing.`
        : `No location was given, so the Opportunity Agent is asking for one instead of guessing.`;
    return {
      status: "completed",
      result,
      toolCalls,
      error: null,
      summary: asked,
    };
  }
  result.origin = origin;

  // One Overpass search through the shared connector (fallback chain, cache,
  // provenance). The fetch limit is above the lead cap so the cap can apply
  // AFTER filtering and ranking.
  const outcome = await searchOverpass({
    selectors: leadSelectors(),
    lat: origin.lat,
    lon: origin.lon,
    radiusMiles,
    elementLimit: LEAD_FETCH_LIMIT,
    reporter,
  });
  toolCalls.push({
    tool: "overpass.search",
    request: outcome.url,
    status: outcome.httpStatus,
    ok: outcome.ok,
    durationMs: outcome.durationMs,
    error: outcome.error ?? undefined,
  });

  result.overpassUrl = outcome.url;
  result.servedBy = outcome.servedBy;
  result.fallbackUsed = outcome.fallbackUsed;
  result.servedFromCache = outcome.fromCache;
  result.elementsFetched = outcome.ok ? outcome.elements.length : null;

  if (!outcome.ok) {
    result.sourceUnavailable = true;
    result.notes = [
      ...notes,
      `The OpenStreetMap Overpass search source is unavailable right now, so no leads could be fetched. ` +
        `${outcome.error ?? "Unknown error."} The preferred request attempted: ${outcome.url}`,
    ];
    return {
      status: "completed",
      result,
      toolCalls,
      error: null,
      summary:
        "Lead search source unavailable: every known Overpass endpoint was tried and none returned usable data. " +
        "No leads were fabricated; the structured result carries the error and every endpoint that was tried.",
    };
  }

  if (outcome.fallbackUsed && outcome.servedBy) {
    notes.push(
      `The preferred Overpass endpoint did not answer, so this search was served by the fallback endpoint ${outcome.servedBy}.`,
    );
  }
  if (outcome.elements.length >= LEAD_FETCH_LIMIT) {
    notes.push(
      `The fetch reached its ${LEAD_FETCH_LIMIT}-element limit, so this area may hold more matches than were fetched; ` +
        `the ranking below covers the fetched elements only.`,
    );
  }

  const { leads: unranked, skips } = filterLeadElements(outcome.elements, origin, radiusMiles);
  const ranked = rankLeads(unranked);
  const fetchedAt = new Date().toISOString();
  result.leads = ranked.slice(0, LEAD_CAP).map((lead) => ({
    ...lead,
    provenance: {
      source: "OpenStreetMap via Overpass API",
      url: outcome.url,
      fetchedAt,
    } satisfies Provenance,
  }));
  result.notes = notes;

  if (skips.duplicates > 0) {
    notes.push(`${skips.duplicates} duplicate element(s) were collapsed.`);
  }
  if (skips.hasWebsiteTag > 0) {
    notes.push(`${skips.hasWebsiteTag} returned element(s) carry a website or contact:website tag and were excluded by the filter (they are not leads).`);
  }
  if (skips.noName > 0) {
    notes.push(`${skips.noName} returned element(s) had no name tag and were excluded rather than named by guesswork.`);
  }
  if (skips.noCategory > 0) {
    notes.push(`${skips.noCategory} returned element(s) had no shop, amenity, craft, office, or tourism tag and were excluded.`);
  }
  if (skips.noCoords > 0) {
    notes.push(`${skips.noCoords} returned element(s) had no usable coordinates and were excluded rather than approximated.`);
  }
  if (skips.outsideRadius > 0) {
    notes.push(`${skips.outsideRadius} returned element(s) fell outside the ${radiusLabel(radiusMiles)}-mile radius (the bounding box is square; the search area is a circle) and were excluded.`);
  }
  if (ranked.length > LEAD_CAP) {
    notes.push(`${ranked.length} matching lead(s) were fetched; the result lists the first ${LEAD_CAP} under the stated ranking (cap ${LEAD_CAP}).`);
  }
  if (result.leads.some((l) => l.category.startsWith("amenity="))) {
    notes.push(
      `OpenStreetMap's amenity tag also covers public amenities (benches, parking, drinking water), so a few non-business objects may appear. ` +
        `Every lead links to its OpenStreetMap object so you can judge each one.`,
    );
  }
  if (result.leads.length === 0) {
    notes.push(
      `No businesses matching the filter were found within ${radiusLabel(radiusMiles)} miles of ${origin.label} in OpenStreetMap data (checked ${outcome.url}). ` +
        `OpenStreetMap coverage varies by area; that is a property of the map data, not a filtered opinion.`,
    );
  }

  const summary =
    result.leads.length > 0
      ? `Found ${result.leads.length} lead(s) within ${radiusLabel(radiusMiles)} miles of ${origin.label}, ranked ${LEADS_RANKING_RULE}. ` +
        `Each lead means no website listed on OpenStreetMap: a listing gap in the map data, not a verified fact about the business.`
      : `No leads in OpenStreetMap within the radius.`;

  return {
    status: "completed",
    result,
    toolCalls,
    error: null,
    summary,
  };
}

/* ---------------------------------------------------------------- execution */

export const opportunityAgent: Agent = {
  spec: opportunitySpec,
  async execute(task: Task, ctx: ExecutionContext): Promise<AgentExecution> {
    // Lead commands ("find leads for X in Y") take the lead-finder path;
    // everything else is the HN + Wikipedia topic scan.
    if (isLeadCommand(task.command)) return executeLeadFinder(task, ctx);
    return executeTopicScan(task, ctx);
  },
};

/** The topic-scan capability: HN (Algolia) + Wikipedia, deterministic ranking. */
async function executeTopicScan(task: Task, ctx: ExecutionContext): Promise<AgentExecution> {
    const subject = (ctx.subject || task.command).trim();
    const reporter = ctx.reporter;
    const notes: string[] = [];
    const toolCalls: ToolCall[] = [];

    // The whole sentence is rarely a good search query ("business opportunities
    // in on-device AI" matches nothing on HN). Reduce it to the actual topic
    // with deterministic prefix stripping, and record honestly which query ran.
    const { topic, extracted } = extractSearchTopic(subject);
    if (extracted) {
      notes.push(
        `Subject "${subject}" was reduced to the search topic "${topic}" with deterministic ` +
          `prefix stripping; sources were queried with the topic, not the whole sentence. ` +
          `The original subject is kept in this result.`,
      );
    }

    // Tool 1: Hacker News via Algolia search (permitted, no key).
    const hnUrl =
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(topic)}` +
      `&tags=story&hitsPerPage=${HN_HITS_PER_PAGE}`;
    const hn = await timedFetchJson("hn.search", hnUrl, { "user-agent": OPEN_DATA_UA }, 10000, reporter);
    toolCalls.push(hn.call);

    let stories: OpportunityStory[] = [];
    let hnUnavailable = false;
    if (hn.json && typeof hn.json === "object" && Array.isArray((hn.json as { hits?: unknown }).hits)) {
      const hits = (hn.json as { hits: unknown[] }).hits;
      const parsed = hits
        .map((h) => parseHnHit(h as AlgoliaHit))
        .filter((s): s is NonNullable<ReturnType<typeof parseHnHit>> => s !== null);
      stories = rankStories(parsed).map((s) => ({
        ...s,
        provenance: {
          source: "Hacker News (Algolia Search API)",
          url: hnUrl,
          fetchedAt: new Date().toISOString(),
        } satisfies Provenance,
      }));
      if (stories.length === 0) {
        notes.push(
          `Hacker News returned no usable story hits for "${topic}" (checked ${hnUrl}). ` +
            `An empty result is reported as empty, never filled in.`,
        );
      }
    } else {
      hnUnavailable = true;
      notes.push(
        hn.call.ok
          ? `Hacker News responded but without a usable hit list (checked ${hnUrl}).`
          : `Hacker News request failed (${hn.call.status ?? hn.call.error ?? "unknown error"}): ${hnUrl}`,
      );
    }

    // Tool 2: Wikipedia REST summary for topic context (permitted, no key).
    const wikiSlug = encodeURIComponent(topic.replace(/\s+/g, "_"));
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${wikiSlug}`;
    const wiki = await timedFetchJson("wikipedia.summary", wikiUrl, { "user-agent": OPEN_DATA_UA }, 10000, reporter);
    toolCalls.push(wiki.call);

    let wikiSection: SummarySection | null = null;
    if (wiki.json && typeof wiki.json === "object") {
      const w = wiki.json as {
        title?: string;
        extract?: string;
        type?: string;
        content_urls?: { desktop?: { page?: string } };
      };
      const provenance: Provenance = {
        source: "Wikipedia REST API (page summary)",
        url: wikiUrl,
        fetchedAt: new Date().toISOString(),
      };
      if (w.extract && w.type !== "disambiguation") {
        wikiSection = {
          text: w.extract,
          title: w.title ?? null,
          articleUrl: w.content_urls?.desktop?.page ?? null,
          provenance,
        };
      } else {
        notes.push(
          w.type === "disambiguation"
            ? `Wikipedia returned a disambiguation page for "${subject}", so no single summary is quoted.`
            : `Wikipedia matched the page but returned no summary text (checked ${wikiUrl}).`,
        );
      }
    } else {
      notes.push(
        wiki.call.ok
          ? `No Wikipedia summary found for "${subject}" (checked ${wikiUrl}).`
          : `Wikipedia request failed (${wiki.call.status ?? wiki.call.error ?? "unknown error"}): ${wikiUrl}`,
      );
    }

    const gotSomething = stories.length > 0 || wikiSection != null;
    const allCallsFailed = toolCalls.length > 0 && toolCalls.every((c) => !c.ok);

    const result: OpportunityScanResult = {
      kind: "opportunity.scan",
      topic: subject,
      hnQuery: topic,
      hnQuerySource: extracted ? "extracted_topic" : "full_subject",
      rankingRule: RANKING_RULE,
      stories,
      wiki: wikiSection,
      hnUnavailable,
      notes,
    };

    const parts = [
      hnUnavailable ? "Hacker News unavailable." : `Hacker News: ${stories.length} story hit(s), ranked ${RANKING_RULE}.`,
      wikiSection ? "Wikipedia context retrieved." : "No Wikipedia summary.",
    ];

    return {
      status: !gotSomething && allCallsFailed ? "failed" : "completed",
      result,
      toolCalls,
      error: !gotSomething && allCallsFailed ? "all permitted sources were unreachable" : null,
      summary: parts.join(" "),
    };
}
