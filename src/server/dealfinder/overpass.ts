/**
 * Overpass API connector for the DealFinder Agent (OpenStreetMap data).
 *
 * Permitted, key-free source. Known operational quirk (verified empirically):
 * overpass-api.de can respond slowly or return an empty body under load even
 * with HTTP 200 / EXIT 0. The connector is designed for that reality:
 *
 * - explicit client timeout (25s; the QL itself asks the server for 20s),
 * - exactly one retry after a short backoff,
 * - an in-process cache so identical queries within the TTL never re-hit the
 *   network,
 * - honest outcomes: ok=false ("search source unavailable") vs ok=true with
 *   zero elements ("no results in this area"). Nothing is ever papered over.
 *
 * GET is used (not POST) so the provenance request URL is openable by the
 * owner. A proper identifying User-Agent is always sent.
 */

import type { ToolCallReporter } from "../agents/base";

export interface OverpassSelector {
  key: string;
  value: string;
  require?: { key: string; value: string };
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
  /** The exact request URL (also the provenance link). */
  url: string;
  /** true when served from the in-process cache instead of the network. */
  fromCache: boolean;
  httpStatus: number | null;
  /** Total wall time of the logical call, including retries. */
  durationMs: number;
  attempts: number;
  error: string | null;
}

export const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
export const DEALFINDER_UA =
  "DealFinder-CommandCenter/0.1 (personal AI dashboard dealfinder agent)";

/**
 * Endpoint is modular: OVERPASS_URL env var overrides the default (e.g. a
 * public mirror when overpass-api.de is degraded). Read per call, never baked
 * in at module load. Provenance always records the URL actually used.
 */
export function overpassEndpoint(): string {
  const u = process.env.OVERPASS_URL?.trim();
  if (u && /^https?:\/\//.test(u)) return u.replace(/\/+$/, "");
  return OVERPASS_ENDPOINT;
}

const CLIENT_TIMEOUT_MS = 25_000;
const RETRY_BACKOFF_MS = 1_500;
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

/** One union query per search: shop=hairdresser plus barber tagging. */
export function buildOverpassQuery(
  selectors: OverpassSelector[],
  bbox: { s: number; w: number; n: number; e: number },
  elementLimit = 50,
): string {
  const box = `(${bbox.s.toFixed(6)},${bbox.w.toFixed(6)},${bbox.n.toFixed(6)},${bbox.e.toFixed(6)})`;
  const parts = selectors.map((sel) => {
    const base = `node["${sel.key}"="${sel.value}"]`;
    const withRequire = sel.require
      ? `${base}["${sel.require.key}"="${sel.require.value}"]`
      : base;
    return `  ${withRequire}${box};`;
  });
  return `[out:json][timeout:20];\n(\n${parts.join("\n")}\n);\nout center ${elementLimit};`;
}

export function buildOverpassUrl(query: string): string {
  return `${overpassEndpoint()}?data=${encodeURIComponent(query)}`;
}

/* ---------------------------------------------------------------- cache */

const cache = new Map<string, { at: number; elements: OverpassElement[] }>();

function cacheKey(query: string): string {
  return query;
}

function cacheGet(query: string): OverpassElement[] | null {
  const hit = cache.get(cacheKey(query));
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(cacheKey(query));
    return null;
  }
  // Refresh LRU position.
  cache.delete(cacheKey(query));
  cache.set(cacheKey(query), hit);
  return hit.elements;
}

function cachePut(query: string, elements: OverpassElement[]): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey(query), { at: Date.now(), elements });
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
 * client timeout, one retry, in-process cache. Never throws; the outcome
 * carries the honest state either way.
 */
export async function searchOverpass(
  opts: OverpassSearchOptions,
): Promise<OverpassOutcome> {
  const bbox = bboxForRadius(opts.lat, opts.lon, opts.radiusMiles);
  const query = buildOverpassQuery(opts.selectors, bbox, opts.elementLimit ?? 50);
  const url = buildOverpassUrl(query);
  const started = Date.now();
  const report = opts.reporter;
  report?.started({ tool: "overpass.search", request: url });

  const finish = (
    ok: boolean,
    httpStatus: number | null,
    error: string | null,
  ): void => {
    report?.finished({
      tool: "overpass.search",
      request: url,
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
    // result payload carries servedFromCache=true so nothing is disguised.
    finish(true, null, null);
    return {
      ok: true,
      elements: cached,
      url,
      fromCache: true,
      httpStatus: null,
      durationMs: Date.now() - started,
      attempts: 0,
      error: null,
    };
  }

  const errors: string[] = [];
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const elements = await attemptFetch(url, CLIENT_TIMEOUT_MS);
      cachePut(query, elements);
      finish(true, 200, null);
      return {
        ok: true,
        elements,
        url,
        fromCache: false,
        httpStatus: 200,
        durationMs: Date.now() - started,
        attempts: attempt,
        error: null,
      };
    } catch (err) {
      errors.push(
        `attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt < maxAttempts) await sleep(RETRY_BACKOFF_MS);
    }
  }

  const error = `Overpass search source unavailable after ${maxAttempts} attempts (${errors.join("; ")})`;
  finish(false, null, error);
  return {
    ok: false,
    elements: [],
    url,
    fromCache: false,
    httpStatus: null,
    durationMs: Date.now() - started,
    attempts: maxAttempts,
    error,
  };
}
