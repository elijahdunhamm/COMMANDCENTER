import type {
  AgentSpec,
  OpportunityScanResult,
  OpportunityStory,
  Provenance,
  SummarySection,
  Task,
  ToolCall,
} from "../types";
import type { Agent, AgentExecution, ExecutionContext } from "./base";
import { OPEN_DATA_UA, timedFetchJson } from "../tools/fetch";

/**
 * Opportunity Agent: real market-signal scanning with permitted, key-free
 * public APIs only.
 *
 * Sources (both free, no key, used per their published terms):
 *  - Hacker News via the Algolia Search API (https://hn.algolia.com/api/v1/search)
 *  - Wikipedia REST page summary
 *
 * Ranking is fully deterministic and stated in the result: stories are ordered
 * by points descending, ties broken by newest first. Every number shown comes
 * straight from the API response; nothing is scored, weighted, or invented.
 */

const opportunitySpec: AgentSpec = {
  id: "opportunity",
  name: "Opportunity Agent",
  kind: "specialist",
  description:
    "Scans Hacker News (Algolia API) and Wikipedia for a topic and returns deterministically ranked, sourced signals.",
  capability: "ready",
  capabilities: [
    "Hacker News search via the Algolia API (free, no key required)",
    "Wikipedia REST page summary for topic context (no key required)",
    "Deterministic ranking (points desc, newest first) stated in every result",
    "Provenance (source, URL, fetched-at) on every story and section",
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

/* ---------------------------------------------------------------- execution */

export const opportunityAgent: Agent = {
  spec: opportunitySpec,
  async execute(task: Task, ctx: ExecutionContext): Promise<AgentExecution> {
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
  },
};
