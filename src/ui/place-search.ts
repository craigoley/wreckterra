/**
 * Place search: finds a real place by name for the start screen's map picker.
 *
 * INVARIANT search-on-submit: nothing here is driven by typing. `search` is called when the player
 * submits the form, never per keystroke (no autocomplete — the public Nominatim service forbids it).
 * Calls are spaced at least one second apart, whatever the caller does, because the public service
 * is not an unbounded backend. Results carry Nominatim's required attribution, shown on screen.
 */
import type { LatLon } from "../maps/city-cache";

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
export const NOMINATIM_ATTRIBUTION = "Search by Nominatim · © OpenStreetMap contributors";
/** The public Nominatim usage policy allows at most one request per second. */
export const MIN_SEARCH_INTERVAL_MS = 1000;
export const MAX_RESULTS = 5;
export const SEARCH_TIMEOUT_MS = 8000;

export interface Place extends LatLon { name: string }

export type PlaceSearchResult =
  | { ok: true; places: Place[] }
  | { ok: false; reason: string };

export interface PlaceSearch {
  /** Look a place up by name. Never rejects: a failure is a result with a reason. */
  search(query: string): Promise<PlaceSearchResult>;
  readonly attribution: string;
}

export interface PlaceSearchOptions {
  fetchImpl?: typeof fetch;
  /** Milliseconds clock; replaced in tests. */
  now?: () => number;
  /** Resolves after the given milliseconds; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  endpoint?: string;
}

interface NominatimHit { display_name?: unknown; lat?: unknown; lon?: unknown }

function readPlaces(body: unknown): Place[] {
  if (!Array.isArray(body)) return [];
  const places: Place[] = [];
  for (const hit of body as NominatimHit[]) {
    if (typeof hit !== "object" || hit === null) continue;
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (typeof hit.display_name !== "string" || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    places.push({ name: hit.display_name, lat, lon });
    if (places.length >= MAX_RESULTS) break;
  }
  return places;
}

/**
 * Create the search the start screen uses. Searches are queued: each waits until a full interval has
 * passed since the previous request began, so a double submit still makes only one request per second.
 */
export function createPlaceSearch(options: PlaceSearchOptions = {}): PlaceSearch {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const interval = options.minIntervalMs ?? MIN_SEARCH_INTERVAL_MS;
  const endpoint = options.endpoint ?? NOMINATIM_URL;
  let lastStart = Number.NEGATIVE_INFINITY;
  let queue: Promise<unknown> = Promise.resolve();

  const run = async (query: string): Promise<PlaceSearchResult> => {
    const wait = lastStart + interval - now();
    if (wait > 0) await sleep(wait);
    lastStart = now();
    const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const url = `${endpoint}?${new URLSearchParams({ q: query, format: "jsonv2", limit: String(MAX_RESULTS) }).toString()}`;
      const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) return { ok: false, reason: `The place search answered HTTP ${response.status}. Try again in a moment.` };
      const places = readPlaces(await response.json());
      return places.length > 0 ? { ok: true, places } : { ok: false, reason: `No place found for “${query}”. Try a city or a neighbourhood name.` };
    } catch (error) {
      const detail = controller.signal.aborted ? "it timed out" : error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `The place search could not be reached (${detail}). You can still tap the map.` };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    attribution: NOMINATIM_ATTRIBUTION,
    search(query: string): Promise<PlaceSearchResult> {
      const trimmed = query.trim();
      if (trimmed.length === 0) return Promise.resolve({ ok: false, reason: "Type a place name to search." });
      const result = queue.then(() => run(trimmed));
      queue = result;
      return result;
    },
  };
}
