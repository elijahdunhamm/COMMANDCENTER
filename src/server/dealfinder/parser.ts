/**
 * Deterministic natural-language parser for DealFinder commands.
 *
 * Pure rules, no network, no LLM. Extensible by adding entries to
 * SERVICE_TYPES or SPECIALTY_PHRASES. The parser only EXTRACTS intent-shaped
 * facts; it never decides what is searchable. In particular, specialties are
 * captured for display but are NOT searchable against OpenStreetMap, which
 * does not index hairstyles, styles, or specialties.
 */

export interface ServiceType {
  key: string;
  label: string;
  /** Overpass tag selectors that identify this service type (union). */
  selectors: {
    key: string;
    value: string;
    /** Optional companion tag that must also be present (e.g. beauty=hairdresser on shop=beauty). */
    require?: { key: string; value: string };
  }[];
  keywords: RegExp;
}

/**
 * Service keyword map. Barber and hairdresser first (the flagship case);
 * add new entries here to extend coverage. All current hairdresser-family
 * services share the same OpenStreetMap tag space, so their selector sets
 * overlap by design: OSM tags barbers mostly as shop=hairdresser, sometimes
 * refined with hairdresser:styling_type=barber or beauty=hairdresser.
 */
export const SERVICE_TYPES: ServiceType[] = [
  {
    key: "barber",
    label: "barber",
    selectors: [
      { key: "shop", value: "hairdresser" },
      { key: "shop", value: "beauty", require: { key: "beauty", value: "hairdresser" } },
      { key: "hairdresser:styling_type", value: "barber" },
    ],
    keywords: /\b(barbers?|barber ?shops?|barber'?s|taper|fade)\b/i,
  },
  {
    key: "hairdresser",
    label: "hairdresser",
    selectors: [
      { key: "shop", value: "hairdresser" },
      { key: "shop", value: "beauty", require: { key: "beauty", value: "hairdresser" } },
    ],
    keywords: /\b(hairdressers?|hair ?salons?|salons?|hairstylists?|hair ?stylists?)\b/i,
  },
];

/**
 * Specialty phrases captured from the command. Displayed in results with an
 * explicit "captured but not searchable" mark: OpenStreetMap does not index
 * hairstyles, so these can never filter or rank real results.
 */
export const SPECIALTY_PHRASES: string[] = [
  "low taper",
  "high taper",
  "taper fade",
  "taper",
  "skin fade",
  "burst fade",
  "fade",
  "buzz cut",
  "crew cut",
  "pompadour",
  "undercut",
  "beard trim",
  "hot shave",
  "lineup",
  "waves",
  "afro",
  "bob",
  "pixie cut",
  "highlights",
  "balayage",
  "perm",
];

const RADIUS_RE =
  /\bwithin\s+(\d+(?:\.\d+)?)\s*(miles?|mi\.?|m\.?i\.?|kilometers?|kilometres?|km)\b/i;
const PRICE_RE =
  /\b(?:under|below|less than|cheaper than|max(?:imum)?(?: of)?|up to)\s+\$(\d+(?:\.\d{1,2})?)\b/i;
const PRICE_WORDS_RE =
  /\b(?:under|below|less than|cheaper than|max(?:imum)?(?: of)?|up to)\s+(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?|bucks)\b/i;
/** Decimal-pair coordinates like "30.2672, -97.7431" (decimals required). */
const COORDS_RE =
  /\b(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})\b/;
/** Explicit place after a location preposition, cut before constraint phrases. */
const PLACE_RE =
  /\b(?:near|around|in|close to)\s+([a-z][a-z0-9 .,''-]*?)(?=\s+(?:within|under|below|less than|that|with|which|open)\b|$|[,.!?;])/i;

export interface RadiusSpec {
  value: number;
  unit: "miles" | "km";
  source: "command" | "default";
}

export interface ParsedDealfinderQuery {
  service: { key: string; label: string; matchedKeyword: string } | null;
  specialties: string[];
  radius: RadiusSpec;
  maxPrice: { amount: number; currency: "USD" } | null;
  /** Coordinates supplied directly in the command, if any. */
  coords: { lat: number; lon: number } | null;
  /** Explicit place name to geocode, if any ("me"/"here" excluded). */
  place: string | null;
  /** Raw phrase after the location preposition, for honest reporting. */
  locationPhrase: string | null;
  /** True when the command says "near me/here" but supplies no coordinates:
   *  the dashboard cannot know where the owner is, so it must ask. */
  unresolvableSelfLocation: boolean;
}

function parseRadius(command: string): RadiusSpec {
  const m = command.match(RADIUS_RE);
  if (m) {
    const value = Number(m[1]);
    const unit = /^k/i.test(m[2]) ? "km" : "miles";
    if (Number.isFinite(value) && value > 0 && value <= 500) {
      return { value, unit, source: "command" };
    }
  }
  return { value: 10, unit: "miles", source: "default" };
}

function parseMaxPrice(command: string): { amount: number; currency: "USD" } | null {
  const m = command.match(PRICE_RE) ?? command.match(PRICE_WORDS_RE);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: "USD" };
}

function parseCoords(command: string): { lat: number; lon: number } | null {
  const m = command.match(COORDS_RE);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return null;
  }
  return { lat, lon };
}

export function parseSpecialties(command: string): string[] {
  // Hyphens and dashes become spaces so "low-taper" matches "low taper".
  const lower = command.toLowerCase().replace(/[-\u2010-\u2015]/g, " ");
  const found: string[] = [];
  for (const phrase of SPECIALTY_PHRASES) {
    // Longest phrases first so "low taper" wins over "taper"; handled by
    // array order above, but the contains check must not double-count.
    if (found.some((f) => f.includes(phrase))) continue;
    const idx = lower.indexOf(phrase);
    if (idx >= 0) found.push(phrase);
  }
  // Keep them in command order.
  return found
    .map((p) => ({ p, i: lower.indexOf(p) }))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.p);
}

export function parseDealfinderQuery(command: string): ParsedDealfinderQuery {
  let service: ParsedDealfinderQuery["service"] = null;
  for (const t of SERVICE_TYPES) {
    const m = command.match(t.keywords);
    if (m) {
      service = { key: t.key, label: t.label, matchedKeyword: m[0].toLowerCase() };
      break;
    }
  }

  const coords = parseCoords(command);

  let place: string | null = null;
  let locationPhrase: string | null = null;
  let unresolvableSelfLocation = false;
  const pm = command.match(PLACE_RE);
  if (pm) {
    const raw = pm[1].trim().replace(/\s+/g, " ");
    locationPhrase = raw;
    const cleaned = raw.replace(/^(the|a|an)\s+/i, "").trim();
    if (/^(me|here|us|my (house|home|place|location)|current location)$/i.test(cleaned)) {
      unresolvableSelfLocation = true;
    } else if (cleaned.length >= 2) {
      place = cleaned;
    }
  }

  return {
    service,
    specialties: parseSpecialties(command),
    radius: parseRadius(command),
    maxPrice: parseMaxPrice(command),
    coords,
    place,
    locationPhrase,
    unresolvableSelfLocation,
  };
}
