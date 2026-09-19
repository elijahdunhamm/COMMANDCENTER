/**
 * Overpass API connector for the DealFinder Agent (OpenStreetMap data).
 *
 * Permitted, key-free source. Known operational quirks (verified empirically):
 * overpass-api.de can be unreachable (connection refused) or respond slowly
 * with an empty body under load even with HTTP 200 / EXIT 0. The connector is
 * designed for that reality:
 *
 * - explicit client timeout (25s per attempt; the QL itself asks for 20s),
 * - a fallback chain of endpoints: the OVERPASS_URL override (if set) first,
 *   then overpass-api.de, then two public mirrors. The first endpoint that
 *   returns a usable answer serves the whole search; the query is never
 *   re-sent to later endpoints once one has answered,
 * - an in-process cache so identical queries within the TTL never re-hit the
 *   network,
 * - honest outcomes: ok=false ("search source unavailable", listing every
 *   endpoint tried) vs ok=true with zero elements ("no results in this
 *   area"). Nothing is ever papered over.
 *
 * GET is used (not POST) so the provenance request URL is openable by the
 * owner. A proper identifying User-Agent is always sent. Provenance always
 * records the endpoint that actually answered.
 */

import type { ToolCallReporter } from "../agents/base";

export interface OverpassSelector {
  key: string;
  /** Fixed tag value to match. Omit to match on key existence only. */
  value?: string;
  /** Optional companion tag that must also be present (e.g. beauty=hairdresser on shop=beauty). */
  require?: { key: string; value?: string };
  /** Extra keys that must exist on the element (existence only), e.g. ["name"]. */
  requireKeys?: string[];
  /** Keys that must be absent, each emitted as a [!"key"] negation filter,
   *  e.g. ["website", "contact:website"] for the missing-website lead filter. */
  excludeKeys?: string[];
}

export interface OverpassElement {
  type: string;
  id: number;
  lat: number | null;
  lon: number | null;
  /** Center of the geometry for ways/relations (`out center`). */
  center: { lat: number; lon: number } | null;
  tags: Record<string, string>;
}

export interface OverpassOutcome {
  /** true = got a usable Overpass JSON response (even with 0 elements). */
  ok: boolean;
  elements: OverpassElement[];
  /** The exact request URL that produced the outcome (also the provenance
   *  link): the answering endpoint's URL on success, the preferred endpoint's
   *  URL when nothing answered. */
  url: string;
  /** Base endpoint that actually answered (null when none did). */
  servedBy: string | null;
  /** true when the answering endpoint was not the first candidate. */
  fallbackUsed: boolean;
  /** Every endpoint attempted, in order (includes the answerer on success). */
  triedEndpoints: string[];
  /** true when served from the in-process cache instead of the network. */
  fromCache: boolean;
  httpStatus: number | null;
  /** Total wall time of the logical call, including every endpoint attempt. */
  durationMs: number;
  attempts: number;
  error: string | null;
}

export const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
/** Public mirrors, tried in order after the primary. Verified healthy as of
 *  Sept 2026 when overpass-api.de refused connections from this network. */
export const OVERPASS_FALLBACK_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/**
 * Endpoint chain is modular: the OVERPASS_URL env var (e.g. a known-good
 * mirror while the primary is degraded) takes first position when set, then
 * the default endpoint, then the mirrors. Read per call, never baked in at
 * module load. Deduplicated preserving order; trailing slashes normalized.
 */
export function overpassEndpointCandidates(): string[] {
  const list: string[] = [];
  const u = process.env.OVERPASS_URL?.trim();
  if (u && /^https?:\/\//.test(u)) list.push(u.replace(/\/+$/, ""));
  list.push(OVERPASS_ENDPOINT, ...OVERPASS_FALLBACK_ENDPOINTS);
  return [...new Set(list)];
}

/** The preferred endpoint: the OVERPASS_URL override if set, else the default. */
export function overpassEndpoint(): string {
  return overpassEndpointCandidates()[0];
}

export const DEALFINDER_UA =
  "DealFinder-CommandCenter/0.1 (personal AI dashboard dealfinder agent)";

const CLIENT_TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 20;

/* ------------------------------------------------------------------ geo */

/** Great-circle distance in miles (haversine). Labeled "computed" in results. */
export function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 3958.7613; // mean Earth radius, miles
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Bounding box (south, west, north, east) that contains the radius circle. */
export function bboxForRadius(
  lat: number,
  lon: number,
  radiusMiles: number,
): { s: number; w: number; n: number; e: number } {
  const radiusKm = radiusMiles * 1.609344;
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / Math.max(1, 111.32 * Math.cos((lat * Math.PI) / 180));
  return {
    s: Math.max(-85, lat - dLat),
    w: Math.max(-180, lon - dLon),
    n: Math.min(85, lat + dLat),
    e: Math.min(180, lon + dLon),
  };
}

/* ---------------------------------------------------------------- query */

/** One union query per selector. A selector with a fixed value emits
 *  ["key"="value"]; one without emits ["key"] (existence). requireKeys adds
 *  ["key"] filters and excludeKeys adds [!"key"] negations, so richer filters
 *  (e.g. named businesses with no website tag) stay one connector. */
export function buildOverpassQuery(
  selectors: OverpassSelector[],
  bbox: { s: number; w: number; n: number; e: number },
  elementLimit = 50,
): string {
  const box = `(${bbox.s.toFixed(6)},${bbox.w.toFixed(6)},${bbox.n.toFixed(6)},${bbox.e.toFixed(6)})`;
  const parts = selectors.map((sel) => {
    let filters =
      sel.value !== undefined
        ? `node["${sel.key}"="${sel.value}"]`
        : `node["${sel.key}"]`;
    if (sel.require) {
      filters +=
        sel.require.value !== undefined
          ? `["${sel.require.key}"="${sel.require.value}"]`
          : `["${sel.require.key}"]`;
    }
    for (const k of sel.requireKeys ?? []) filters += `["${k}"]`;
    for (const k of sel.excludeKeys ?? []) filters += `[!"${k}"]`;
    return `  ${filters}${box};`;
  });
  return `[out:json][timeout:20];\n(\n${parts.join("\n")}\n);\nout center ${elementLimit};`;
}

export function buildOverpassUrl(query: string, endpoint = overpassEndpoint()): string {
  return `${endpoint}?data=${encodeURIComponent(query)}`;
}

/* ---------------------------------------------------------------- cache */

const cache = new Map<
  string,
  { at: number; elements: OverpassElement[]; endpoint: string }
>();

function cacheKey(query: string): string {
  return query;
}

function cacheGet(
  query: string,
): { elements: OverpassElement[]; endpoint: string } | null {
  const hit = cache.get(cacheKey(query));
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(cacheKey(query));
    return null;
  }
  // Refresh LRU position.
  cache.delete(cacheKey(query));
  cache.set(cacheKey(query), hit);
  return { elements: hit.elements, endpoint: hit.endpoint };
}

function cachePut(
  query: string,
  elements: OverpassElement[],
  endpoint: string,
): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey(query), { at: Date.now(), elements, endpoint });
}

/* ---------------------------------------------------------------- fetch */

interface OverpassResponse {
  elements?: {
    type?: string;
    id?: number;
    lat?: number;
    lon?: number;
    center?: { lat?: number; lon?: number };
    tags?: Record<string, string>;
  }[];
}

function normalizeElements(json: unknown): OverpassElement[] {
  if (typeof json !== "object" || json === null) return [];
  const elements = (json as OverpassResponse).elements;
  if (!Array.isArray(elements)) return [];
  return elements.flatMap((e) => {
    if (typeof e?.id !== "number" || typeof e?.type !== "string") return [];
    const lat = e.center?.lat ?? e.lat ?? null;
    const lon = e.center?.lon ?? e.lon ?? null;
    return [
      {
        type: e.type,
        id: e.id,
        lat: typeof lat === "number" ? lat : null,
        lon: typeof lon === "number" ? lon : null,
        center:
          typeof e.center?.lat === "number" && typeof e.center?.lon === "number"
            ? { lat: e.center.lat, lon: e.center.lon }
            : null,
        tags: e.tags ?? {},
      },
    ];
  });
}

/** One GET attempt. Throws on network error, non-200, or unparseable body. */
async function attemptFetch(
  url: string,
  timeoutMs: number,
): Promise<OverpassElement[]> {
  const res = await fetch(url, {
    headers: { "user-agent": DEALFINDER_UA, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Overpass`);
  }
  const text = await res.text();
  // Known degradation mode: HTTP 200 with an empty or truncated body.
  if (!text.trim()) {
    throw new Error("HTTP 200 with an empty response body (server under load)");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("HTTP 200 with an unparseable (non-JSON) response body");
  }
  return normalizeElements(json);
}

export interface OverpassSearchOptions {
  selectors: OverpassSelector[];
  lat: number;
  lon: number;
  radiusMiles: number;
  elementLimit?: number;
  /** Real-time reporting: the logical call fires started/finished exactly once
   *  each, even when a retry happens or the cache serves the result. */
  reporter?: ToolCallReporter;
}

/**
 * Run one Overpass search: query built from the selectors and radius bbox,
 * then walked down the endpoint candidate chain (OVERPASS_URL override, then
 * the default, then mirrors) with the same 25s client timeout per attempt.
 * The first endpoint that answers serves the whole logical search; the query
 * is never re-sent to later endpoints once one has answered, so one search
 * still means exactly one executed query. In-process cache keyed by query.
 * Never throws; the outcome carries the honest state either way.
 */
export async function searchOverpass(
  opts: OverpassSearchOptions,
): Promise<OverpassOutcome> {
  const bbox = bboxForRadius(opts.lat, opts.lon, opts.radiusMiles);
  const query = buildOverpassQuery(opts.selectors, bbox, opts.elementLimit ?? 50);
  const candidates = overpassEndpointCandidates();
  const preferredUrl = buildOverpassUrl(query, candidates[0]);
  const started = Date.now();
  const report = opts.reporter;
  report?.started({ tool: "overpass.search", request: preferredUrl });

  const finish = (
    requestUrl: string,
    ok: boolean,
    httpStatus: number | null,
    error: string | null,
  ): void => {
    report?.finished({
      tool: "overpass.search",
      request: requestUrl,
      status: httpStatus,
      ok,
      durationMs: Date.now() - started,
      ...(error ? { error } : {}),
    });
  };

  const cached = cacheGet(query);
  if (cached) {
    // A cache hit is still the logical tool call: reported, with durationMs
    // near zero and no HTTP status (no fresh network request was made). The
    // result payload carries servedFromCache=true and provenance keeps the
    // endpoint that originally answered, so nothing is disguised.
    const url = buildOverpassUrl(query, cached.endpoint);
    finish(url, true, null, null);
    return {
      ok: true,
      elements: cached.elements,
      url,
      servedBy: cached.endpoint,
      fallbackUsed: cached.endpoint !== candidates[0],
      triedEndpoints: [cached.endpoint],
      fromCache: true,
      httpStatus: null,
      durationMs: Date.now() - started,
      attempts: 0,
      error: null,
    };
  }

  const errors: string[] = [];
  const tried: string[] = [];
  for (const endpoint of candidates) {
    const url = buildOverpassUrl(query, endpoint);
    tried.push(endpoint);
    try {
      const elements = await attemptFetch(url, CLIENT_TIMEOUT_MS);
      cachePut(query, elements, endpoint);
      finish(url, true, 200, null);
      return {
        ok: true,
        elements,
        url,
        servedBy: endpoint,
        fallbackUsed: endpoint !== candidates[0],
        triedEndpoints: tried,
        fromCache: false,
        httpStatus: 200,
        durationMs: Date.now() - started,
        attempts: tried.length,
        error: null,
      };
    } catch (err) {
      errors.push(`${endpoint} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const error =
    `Overpass search source unavailable after trying ${tried.length} endpoint(s), in order: ` +
    `${errors.join("; ")}.`;
  finish(preferredUrl, false, null, error);
  return {
    ok: false,
    elements: [],
    url: preferredUrl,
    servedBy: null,
    fallbackUsed: false,
    triedEndpoints: tried,
    fromCache: false,
    httpStatus: null,
    durationMs: Date.now() - started,
    attempts: tried.length,
    error,
  };
}
