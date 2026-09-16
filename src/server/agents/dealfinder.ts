import type { AgentSpec, Provenance, ToolCall } from "../types";
import type {
  DealFinderHit,
  DealFinderOrigin,
  DealFinderSearchResult,
} from "../types";
import type { Agent, AgentExecution, ExecutionContext } from "./base";
import {
  parseDealfinderQuery,
  SERVICE_TYPES,
} from "../dealfinder/parser";
import {
  DEALFINDER_UA,
  haversineMiles,
  searchOverpass,
} from "../dealfinder/overpass";

/**
 * DealFinder Agent: natural-language local-service search against
 * OpenStreetMap (via Overpass), with per-field provenance and honest
 * unverified states. Prices are NEVER invented: OSM carries no price data, so
 * every result's price is "not verified" with an explicit explanation, and a
 * price cap is stated to be unapplied rather than quietly ignored.
 */

const dealfinderSpec: AgentSpec = {
  id: "dealfinder",
  name: "DealFinder Agent",
  kind: "specialist",
  description:
    "Natural-language local-service search over OpenStreetMap with provenance, computed distances, and honest unverified states.",
  capability: "ready",
  capabilities: [
    "Deterministic command parser (service type, specialties, radius, price cap, location)",
    "Nominatim geocoding for place-based origins (no key required)",
    "Overpass local search: hairdresser-family businesses within a radius (no key required)",
    "Computed haversine distance per hit, ranked nearest first",
    "Per-hit provenance (source, request URL, fetched-at); prices always 'not verified'",
  ],
  handlesIntents: ["dealfinder"],
};

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

interface NominatimHit {
  display_name?: string;
  lat?: string;
  lon?: string;
}

interface GeocodeOutcome {
  origin: DealFinderOrigin | null;
  call: ToolCall;
}

async function geocodePlace(
  place: string,
  reporter?: ExecutionContext["reporter"],
): Promise<GeocodeOutcome> {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(place)}&format=jsonv2&limit=1`;
  reporter?.started({ tool: "nominatim.search", request: url });
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "user-agent": DEALFINDER_UA },
      signal: AbortSignal.timeout(10000),
    });
    const durationMs = Date.now() - started;
    if (!res.ok) {
      const call: ToolCall = {
        tool: "nominatim.search",
        request: url,
        status: res.status,
        ok: false,
        durationMs,
      };
      reporter?.finished(call);
      return { origin: null, call };
    }
    const json = (await res.json()) as unknown;
    const call: ToolCall = {
      tool: "nominatim.search",
      request: url,
      status: res.status,
      ok: true,
      durationMs,
    };
    reporter?.finished(call);
    if (Array.isArray(json) && json.length > 0) {
      const hit = json[0] as NominatimHit;
      const lat = hit.lat != null ? Number(hit.lat) : null;
      const lon = hit.lon != null ? Number(hit.lon) : null;
      if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
        const provenance: Provenance = {
          source: "OpenStreetMap Nominatim",
          url,
          fetchedAt: new Date().toISOString(),
        };
        return {
          origin: {
            kind: "geocoded",
            label: hit.display_name ?? `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
            lat,
            lon,
            provenance,
          },
          call,
        };
      }
    }
    return { origin: null, call };
  } catch (err) {
    const call: ToolCall = {
      tool: "nominatim.search",
      request: url,
      status: null,
      ok: false,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
    reporter?.finished(call);
    return { origin: null, call };
  }
}

/** Address built only from real addr:* tags; null when OSM lists none. */
function buildAddress(tags: Record<string, string>): string | null {
  const parts = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
    tags["addr:city"],
    tags["addr:postcode"],
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Category line from the real OSM tags that matched the search selectors. */
function buildCategory(tags: Record<string, string>): string {
  const bits: string[] = [];
  if (tags["shop"]) bits.push(`shop=${tags["shop"]}`);
  if (tags["beauty"]) bits.push(`beauty=${tags["beauty"]}`);
  if (tags["hairdresser:styling_type"]) {
    bits.push(`hairdresser:styling_type=${tags["hairdresser:styling_type"]}`);
  }
  return bits.length > 0 ? bits.join(", ") : "OpenStreetMap node";
}

function priceNeverVerified(): DealFinderHit["price"] {
  return {
    verified: false,
    display: "not verified",
    explanation:
      "OpenStreetMap carries no price data for this place, so no price could be verified.",
  };
}

function emptyResult(command: string, parsed: ReturnType<typeof parseDealfinderQuery>): DealFinderSearchResult {
  return {
    kind: "dealfinder.search",
    command,
    service: parsed.service,
    specialties: parsed.specialties,
    specialtySearchable: false,
    radiusMiles:
      parsed.radius.unit === "km" ? parsed.radius.value * 0.621371 : parsed.radius.value,
    radiusSource: parsed.radius.source,
    maxPrice: parsed.maxPrice,
    origin: null,
    askedForLocation: false,
    sourceUnavailable: false,
    servedFromCache: false,
    overpassUrl: null,
    results: [],
    notes: [],
  };
}

export const dealfinderAgent: Agent = {
  spec: dealfinderSpec,
  async execute(task, ctx: ExecutionContext): Promise<AgentExecution> {
    const command = task.command;
    const parsed = parseDealfinderQuery(command);
    const reporter = ctx.reporter;
    const notes: string[] = [];
    const toolCalls: ToolCall[] = [];

    // No recognized service type: honest structured answer, no search invented.
    if (!parsed.service) {
      const result = emptyResult(command, parsed);
      result.notes.push(
        `No recognized service type in this command. Currently supported: ` +
          SERVICE_TYPES.map((t) => t.label).join(", ") +
          `. Extend SERVICE_TYPES in src/server/dealfinder/parser.ts to cover more.`,
      );
      return {
        status: "completed",
        result,
        toolCalls,
        error: null,
        summary:
          "No recognized service type was found, so no search was run. " +
          "The structured result lists the currently supported service types.",
      };
    }

    // Specialties are captured for display, never searched: OSM does not
    // index hairstyles. This note fires whenever one was requested.
    if (parsed.specialties.length > 0) {
      notes.push(
        `Specialty phrase(s) "${parsed.specialties.join('", "')}" were captured from the command but are marked unsearchable: ` +
          `OpenStreetMap does not index hairstyles or specialties, so they could not be used to filter or rank results.`,
      );
    }

    const radiusMiles =
      parsed.radius.unit === "km" ? parsed.radius.value * 0.621371 : parsed.radius.value;

    // Resolve the search origin: coordinates in the command, else geocode an
    // explicit place, else ask the owner. Never guess a location.
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
          `Provide a place name (e.g. "near downtown Austin") or coordinates (e.g. "near 30.2672, -97.7431").`,
      );
    } else {
      notes.push(
        `No location could be found in the command, so no search area could be determined. ` +
          `Provide a place name (e.g. "near downtown Austin") or coordinates (e.g. "near 30.2672, -97.7431").`,
      );
    }

    if (!origin) {
      // Structured ask-for-location: a real completed outcome, no invented area.
      const result = emptyResult(command, parsed);
      result.askedForLocation = true;
      result.notes = notes;
      const asked =
        parsed.unresolvableSelfLocation || parsed.place
          ? `The location could not be resolved, so the DealFinder Agent is asking for one instead of guessing.`
          : `No location was given, so the DealFinder Agent is asking for one instead of guessing.`;
      return {
        status: "completed",
        result,
        toolCalls,
        error: null,
        summary: asked,
      };
    }

    // Price honesty note: fires whenever a cap was set, because OSM simply has
    // no price data to check against.
    if (parsed.maxPrice) {
      notes.push(
        `You asked for results under $${parsed.maxPrice.amount}. Prices could not be checked against OpenStreetMap data ` +
          `(OSM carries no price information), so no result is price-verified and none was filtered or ranked on price.`,
      );
    }

    // One Overpass search: hairdresser-family tags within the radius bbox.
    const service = SERVICE_TYPES.find((t) => t.key === parsed.service?.key);
    const outcome = await searchOverpass({
      selectors: service?.selectors ?? [],
      lat: origin.lat,
      lon: origin.lon,
      radiusMiles,
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

    const result = emptyResult(command, parsed);
    result.origin = origin;
    result.overpassUrl = outcome.url;
    result.servedFromCache = outcome.fromCache;

    if (!outcome.ok) {
      // Honest unavailable state: retries exhausted, nothing usable came back.
      result.sourceUnavailable = true;
      result.notes = [
        ...notes,
        `The OpenStreetMap Overpass search source is unavailable right now, so no results could be fetched. ` +
          `${outcome.error ?? "Unknown error."} The exact request attempted: ${outcome.url}`,
      ];
      return {
        status: "completed",
        result,
        toolCalls,
        error: null,
        summary:
          "Search source unavailable: the Overpass request did not return usable data after a retry. " +
          "No results were fabricated; the structured result carries the error and the exact request URL.",
      };
    }

    // Normalize hits: rank by computed distance, drop anything beyond the
    // radius (the bbox is square; the request is a circle).
    const fetchedAt = new Date().toISOString();
    const hits: DealFinderHit[] = [];
    let skippedNoCoords = 0;
    for (const el of outcome.elements) {
      const lat = el.center?.lat ?? el.lat;
      const lon = el.center?.lon ?? el.lon;
      if (lat == null || lon == null) {
        skippedNoCoords++;
        continue;
      }
      const distanceMiles = haversineMiles(origin.lat, origin.lon, lat, lon);
      if (distanceMiles > radiusMiles + 0.0001) continue;
      const distanceKm = distanceMiles * 1.609344;

      const whyParts = [
        `${distanceMiles.toFixed(1)} mi from the search point (computed), inside the ${radiusMiles.toFixed(radiusMiles % 1 === 0 ? 0 : 1)}-mile radius`,
        `matched OpenStreetMap tagging: ${buildCategory(el.tags)}`,
      ];
      if (parsed.maxPrice) {
        whyParts.push(
          `price could not be checked, so the $${parsed.maxPrice.amount} cap was not applied`,
        );
      }
      if (parsed.specialties.length > 0) {
        whyParts.push(
          `specialty term(s) "${parsed.specialties.join('", "')}" cannot be searched in OpenStreetMap`,
        );
      }

      hits.push({
        osmType: el.type,
        osmId: el.id,
        osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        name: el.tags["name"]?.trim() || null,
        category: buildCategory(el.tags),
        lat,
        lon,
        distanceMiles,
        distanceKm,
        address: buildAddress(el.tags),
        phone: el.tags["phone"] ?? el.tags["contact:phone"] ?? el.tags["contact:mobile"] ?? null,
        website: el.tags["website"] ?? el.tags["contact:website"] ?? null,
        openingHours: el.tags["opening_hours"]?.trim() || null,
        price: priceNeverVerified(),
        why: whyParts.join("; "),
        provenance: {
          source: "OpenStreetMap via Overpass API",
          url: outcome.url,
          fetchedAt,
        },
      });
    }
    hits.sort((a, b) => a.distanceMiles - b.distanceMiles);
    result.results = hits;

    if (skippedNoCoords > 0) {
      notes.push(
        `${skippedNoCoords} returned element(s) had no usable coordinates and were excluded rather than approximated.`,
      );
    }
    if (hits.length === 0) {
      notes.push(
        `No ${service?.label ?? "matching"} businesses were found within ${radiusMiles.toFixed(radiusMiles % 1 === 0 ? 0 : 1)} miles of ${origin.label} in OpenStreetMap data (checked ${outcome.url}). ` +
          `OpenStreetMap coverage varies by area; that is a property of the map data, not a filtered opinion.`,
      );
    }
    result.notes = notes;

    const priceBit = parsed.maxPrice
      ? ` Prices could not be checked against OpenStreetMap data.`
      : "";
    const summary =
      hits.length > 0
        ? `Found ${hits.length} ${service?.label ?? "matching"} result(s) within ${radiusMiles.toFixed(radiusMiles % 1 === 0 ? 0 : 1)} miles of ${origin.label}, ranked by computed distance.${priceBit} Every price is marked not verified.`
        : `No matches in OpenStreetMap within the radius.${priceBit}`;

    return {
      status: "completed",
      result,
      toolCalls,
      error: null,
      summary,
    };
  },
};
