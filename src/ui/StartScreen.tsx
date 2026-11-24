/**
 * Start screen: the first thing the player sees. Pick a real place on a world map (or from the
 * suggestions, the last five places played, or a name search), choose a car, and press Play.
 *
 * INVARIANT menus-start-play: a match starts only from the Play button here (or Restart on the
 * results screen). Tapping the map only moves the pin; it never loads a city or starts a match.
 *
 * `useStartFlow` owns the flow (start -> loading -> playing, or refused) so `App` can drive it; the
 * map is created through the `MapFactory` seam so tests (and devices without WebGL) can replace it.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { VehicleScene, VEHICLES, type Vehicle } from "../game/VehicleScene";
import type { LatLon } from "../maps/city-cache";
import type { CityData } from "../maps/city-compiler";
import { LIVE_HALF_SIZE_M, OPENMAPTILES_ATTRIBUTION, type LiveCityOutcome } from "../maps/tile-city";
import type { Place, PlaceSearch } from "./place-search";

/* ------------------------------------------------------------------ places */

export const MIDTOWN: Place = { name: "Midtown Manhattan, New York", lat: 40.758, lon: -73.9855 };
export const SUGGESTED_PLACES: readonly Place[] = [
  MIDTOWN,
  { name: "The Loop, Chicago", lat: 41.8819, lon: -87.6278 },
  { name: "Downtown San Francisco", lat: 37.7879, lon: -122.4075 },
  { name: "Shibuya, Tokyo", lat: 35.6595, lon: 139.7005 },
];
export const RECENT_KEY = "wreckterra.recent-places.v1";
export const MAX_RECENT = 5;
export const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

type PlaceStorage = Pick<Storage, "getItem" | "setItem">;

function isPlace(value: unknown): value is Place {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && typeof v.lat === "number" && typeof v.lon === "number" && Number.isFinite(v.lat) && Number.isFinite(v.lon);
}

/** The last places played, newest first. Anything unreadable is treated as no history. */
export function readRecentPlaces(storage: PlaceStorage | null): Place[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isPlace).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

/** Put a place at the front of the history (one entry per spot, five at most) and return the new list. */
export function rememberPlace(storage: PlaceStorage | null, place: Place): Place[] {
  const same = (p: Place) => p.name === place.name || (Math.abs(p.lat - place.lat) < 0.001 && Math.abs(p.lon - place.lon) < 0.001);
  const next = [place, ...readRecentPlaces(storage).filter((p) => !same(p))].slice(0, MAX_RECENT);
  try { storage?.setItem(RECENT_KEY, JSON.stringify(next)); } catch { return next; }
  return next;
}

/** A tap on a wrapped world map can report a longitude past +-180; bring it back and clamp the latitude. */
export function normalisePoint(point: LatLon): LatLon {
  const lon = ((((point.lon + 180) % 360) + 360) % 360) - 180;
  return { lat: Math.max(-90, Math.min(90, point.lat)), lon };
}

export function describePoint(point: LatLon): string {
  return `Dropped pin (${point.lat.toFixed(4)}, ${point.lon.toFixed(4)})`;
}

/** The square the match covers around a point, as a closed GeoJSON ring of [lon, lat] corners. */
export function playAreaRing(point: LatLon, halfSizeM: number = LIVE_HALF_SIZE_M): [number, number][] {
  const lat = Math.max(-85, Math.min(85, point.lat));
  const dLat = halfSizeM / 111_320;
  const dLon = halfSizeM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [[point.lon - dLon, lat - dLat], [point.lon + dLon, lat - dLat], [point.lon + dLon, lat + dLat], [point.lon - dLon, lat + dLat], [point.lon - dLon, lat - dLat]];
}

/* ------------------------------------------------------------------ the flow */

export interface StartFlowDeps {
  /** Build a live city for a point, reporting progress messages as it goes. */
  loadCity(point: LatLon, report: (message: string) => void): Promise<LiveCityOutcome>;
  /** The pinned Midtown city offered when a place is refused; null when it could not be read. */
  pinned: CityData | null;
  storage?: PlaceStorage | null;
}

export type FlowPhase =
  | { name: "start" }
  | { name: "loading"; place: Place; message: string }
  | { name: "refused"; place: Place; reason: string }
  | { name: "playing"; place: Place; city: CityData; live: boolean };

export interface PickedPlace { place: Place; /** True when the map should fly to it (a list or search pick, not a tap on the map). */ fly: boolean }

export interface StartFlow {
  phase: FlowPhase;
  picked: PickedPlace;
  recent: Place[];
  pinnedAvailable: boolean;
  pick(place: Place, fly: boolean): void;
  /** Start a match at a place. Called only from the Play button. */
  play(place: Place): void;
  /** Play the pinned Midtown city, offered after a refusal. */
  playPinned(): void;
  /** Back to the start screen (also cancels a load in progress). */
  changePlace(): void;
}

function defaultStorage(): PlaceStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export function useStartFlow(deps: StartFlowDeps): StartFlow {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const storage = useRef<PlaceStorage | null | undefined>(undefined);
  if (storage.current === undefined) storage.current = deps.storage === undefined ? defaultStorage() : deps.storage;
  const token = useRef(0);
  const [phase, setPhase] = useState<FlowPhase>({ name: "start" });
  const [picked, setPicked] = useState<PickedPlace>({ place: MIDTOWN, fly: false });
  const [recent, setRecent] = useState<Place[]>(() => readRecentPlaces(storage.current ?? null));

  const play = (place: Place) => {
    const mine = (token.current += 1);
    const live = () => token.current === mine;
    setPhase({ name: "loading", place, message: "Starting…" });
    depsRef.current.loadCity({ lat: place.lat, lon: place.lon }, (message) => { if (live()) setPhase({ name: "loading", place, message }); })
      .then((outcome) => {
        if (!live()) return;
        if (outcome.ok) {
          setRecent(rememberPlace(storage.current ?? null, place));
          setPhase({ name: "playing", place, city: outcome.city, live: true });
        } else {
          setPhase({ name: "refused", place, reason: outcome.reason });
        }
      }, (error: unknown) => {
        if (live()) setPhase({ name: "refused", place, reason: `The city could not be built (${error instanceof Error ? error.message : String(error)}).` });
      });
  };

  return {
    phase,
    picked,
    recent,
    pinnedAvailable: deps.pinned !== null,
    pick: (place, fly) => setPicked({ place, fly }),
    play,
    playPinned: () => {
      const city = depsRef.current.pinned;
      if (!city) return;
      token.current += 1;
      setPhase({ name: "playing", place: MIDTOWN, city, live: false });
    },
    changePlace: () => { token.current += 1; setPhase({ name: "start" }); },
  };
}

/* ------------------------------------------------------------------ the map */

export interface PickerMap {
  /** Move the pin and the preview square to a point; `fly` also pans the map there. */
  show(point: LatLon, fly: boolean): void;
  destroy(): void;
}
export interface MapOptions { center: LatLon; onPick(point: LatLon): void; onProblem(message: string): void }
export type MapFactory = (element: HTMLElement, options: MapOptions) => Promise<PickerMap>;

function webglAvailable(): boolean {
  return typeof WebGL2RenderingContext !== "undefined" || typeof WebGLRenderingContext !== "undefined";
}

/** The real map: MapLibre GL with OpenFreeMap's liberty style (no API key), loaded on demand. */
export const createMapLibreMap: MapFactory = async (element, options) => {
  const [{ Map: MapLibreMap, Marker }] = await Promise.all([import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl.css")]);
  const map = new MapLibreMap({
    container: element,
    style: MAP_STYLE_URL,
    center: [options.center.lon, options.center.lat],
    zoom: 11,
    attributionControl: { compact: true },
  });
  const marker = new Marker({ color: "#e88b43" });
  let ready = false;
  let latest: LatLon | null = null;
  const draw = () => {
    if (!latest) return;
    marker.setLngLat([latest.lon, latest.lat]).addTo(map);
    if (!ready) return;
    const source = map.getSource("play-area");
    if (source && "setData" in source) {
      (source as unknown as { setData(data: unknown): void }).setData({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [playAreaRing(latest)] } });
    }
  };
  map.on("load", () => {
    map.addSource("play-area", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [playAreaRing(options.center)] } } });
    map.addLayer({ id: "play-area-fill", type: "fill", source: "play-area", paint: { "fill-color": "#e88b43", "fill-opacity": 0.22 } });
    map.addLayer({ id: "play-area-line", type: "line", source: "play-area", paint: { "line-color": "#e88b43", "line-width": 2 } });
    ready = true;
    draw();
  });
  map.on("click", (event: { lngLat: { lat: number; lng: number } }) => options.onPick(normalisePoint({ lat: event.lngLat.lat, lon: event.lngLat.lng })));
  map.on("error", () => { if (!ready) options.onProblem("The map style could not be loaded. You can still pick a suggested place or search by name."); });
  return {
    show(point, fly) {
      latest = point;
      draw();
      if (fly) map.flyTo({ center: [point.lon, point.lat], zoom: Math.max(map.getZoom(), 13) });
    },
    destroy() { marker.remove(); map.remove(); },
  };
};

function PlacePicker({ picked, onPick, createMap }: { picked: PickedPlace; onPick: (point: LatLon) => void; createMap: MapFactory | null }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<PickerMap | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const latest = useRef(picked);
  latest.current = picked;
  const [problem, setProblem] = useState<string | null>(createMap ? null : "The world map needs WebGL, which this device does not offer. Pick a suggested place or search by name.");

  useEffect(() => {
    if (!createMap || !host.current) return undefined;
    let gone = false;
    createMap(host.current, { center: latest.current.place, onPick: (point) => onPickRef.current(point), onProblem: setProblem })
      .then((map) => {
        if (gone) { map.destroy(); return; }
        handle.current = map;
        map.show(latest.current.place, false);
      }, (error: unknown) => { if (!gone) setProblem(`The world map could not start (${error instanceof Error ? error.message : String(error)}). Pick a suggested place or search by name.`); });
    return () => { gone = true; handle.current?.destroy(); handle.current = null; };
  }, [createMap]);

  useEffect(() => { handle.current?.show(picked.place, picked.fly); }, [picked]);

  return <div className="picker">
    {problem ? <p role="alert" className="picker-problem">{problem}</p> : null}
    <div ref={host} className="picker-map" role="application" aria-label="World map: tap to drop a pin" hidden={!createMap} />
    <p className="picker-note">Tap the map to drop a pin. The orange square is the {LIVE_HALF_SIZE_M * 2} m play area. {OPENMAPTILES_ATTRIBUTION}.</p>
  </div>;
}

/* ------------------------------------------------------------------ the screen */

type Mode = "touch" | "keyboard";

function controlsMode(): Mode {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches ? "touch" : "keyboard";
}

function ControlsCard({ mode }: { mode: Mode }) {
  return <section className="controls-card" aria-label="Controls">
    <h2>Controls</h2>
    {mode === "touch"
      ? <p>Use the pads under the city: left and right to steer, gas, reverse and brake, then fire, missile and special.</p>
      : <p>Arrows or WASD to drive, Space or J to fire, K for a missile, L for your special, R to restart. A gamepad works too.</p>}
  </section>;
}

function PlaceSearchBox({ search, onPick }: { search: PlaceSearch; onPick: (place: Place) => void }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  // Searching happens only when the form is submitted; typing never calls the search.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    search.search(query).then((result) => {
      setBusy(false);
      if (result.ok) { setPlaces(result.places); setMessage(null); } else { setPlaces([]); setMessage(result.reason); }
    }, (error: unknown) => {
      setBusy(false);
      setPlaces([]);
      setMessage(`The place search failed (${error instanceof Error ? error.message : String(error)}).`);
    });
  };
  return <div className="place-search">
    <form role="search" onSubmit={submit}>
      <label htmlFor="place-query">Search for a place</label>
      <div className="place-search-row">
        <input id="place-query" type="search" value={query} placeholder="Paris, Lagos, Osaka…" autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
      </div>
    </form>
    {message ? <p role="status" className="place-search-note">{message}</p> : null}
    {places.length > 0 ? <ul className="place-results" aria-label="Search results">{places.map((place) => <li key={`${place.lat},${place.lon},${place.name}`}><button type="button" onClick={() => onPick(place)}>{place.name}</button></li>)}</ul> : null}
    <p className="place-search-credit">{search.attribution}</p>
  </div>;
}

export interface StartScreenProps {
  flow: StartFlow;
  search: PlaceSearch;
  selected: number;
  onSelectVehicle(index: number): void;
  /** Replaces the MapLibre map; omitted in the app, supplied by tests. */
  createMap?: MapFactory;
}

export function StartScreen({ flow, search, selected, onSelectVehicle, createMap }: StartScreenProps) {
  const vehicle: Vehicle = VEHICLES[selected]!;
  const [mode] = useState(controlsMode);
  const [factory] = useState<MapFactory | null>(() => createMap ?? (webglAvailable() ? createMapLibreMap : null));
  const { phase, picked } = flow;

  if (phase.name === "loading") {
    return <section className="start-loading" aria-label="Loading the city">
      <h2>Building {phase.place.name}</h2>
      <p role="status">{phase.message}</p>
      <button type="button" onClick={flow.changePlace}>Cancel</button>
    </section>;
  }
  if (phase.name === "refused") {
    return <section className="start-refused" aria-label="Place refused">
      <h2>{phase.place.name} cannot be played</h2>
      <p role="alert">{phase.reason}</p>
      <div className="start-actions">
        <button type="button" onClick={flow.changePlace}>Choose another place</button>
        {flow.pinnedAvailable ? <button type="button" onClick={flow.playPinned}>Play pinned Midtown</button> : <p>The pinned Midtown city could not be read either.</p>}
      </div>
    </section>;
  }

  const choose = (place: Place) => flow.pick(place, true);
  return <section className="start" aria-label="Start screen">
    <section className="place-picker" aria-label="Choose a place">
      <h2>Where to?</h2>
      <PlacePicker picked={picked} createMap={factory} onPick={(point) => flow.pick({ ...point, name: describePoint(point) }, false)} />
      <p className="picked" aria-live="polite">Selected place: <strong>{picked.place.name}</strong></p>
      <div className="place-chips" role="group" aria-label="Suggested places">{SUGGESTED_PLACES.map((place) => <button key={place.name} type="button" onClick={() => choose(place)}>{place.name}</button>)}</div>
      {flow.recent.length > 0 ? <div className="place-chips" role="group" aria-label="Recent places">{flow.recent.map((place) => <button key={`${place.lat},${place.lon}`} type="button" onClick={() => choose(place)}>{place.name}</button>)}</div> : null}
      <PlaceSearchBox search={search} onPick={choose} />
    </section>
    <section className="garage" aria-label="Vehicle garage"><VehicleScene vehicle={vehicle} />
      <div className="vehicle-heading"><div><p className="eyebrow">Your ride</p><h2>{vehicle.name}</h2></div><p>{vehicle.role}</p></div>
      <div className="choices" role="group" aria-label="Choose a vehicle">{VEHICLES.map((item, index) => <button key={item.id} type="button" aria-pressed={selected === index} onClick={() => onSelectVehicle(index)}><span>{item.name}</span><small>{item.role}</small></button>)}</div>
      <dl className="stats" aria-live="polite"><div><dt>Speed</dt><dd>{vehicle.speed} / 5</dd></div><div><dt>Armor</dt><dd>{vehicle.armor} / 5</dd></div><div><dt>Arena</dt><dd>{picked.place.name}</dd></div></dl>
    </section>
    <ControlsCard mode={mode} />
    <button type="button" className="play" onClick={() => flow.play(picked.place)}>Play</button>
  </section>;
}
