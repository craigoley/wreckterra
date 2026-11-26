import { useCallback, useEffect, useRef, useState } from "react";
import cityFile from "../public/maps/midtown/city.json";
import { Hud } from "./game/Hud";
import type { DrivingControls } from "./game/input";
import { RUNNING, type LifecycleState, type PageLifecycle } from "./game/lifecycle";
import { TouchControls } from "./game/TouchControls";
import { bindMatchRuntime, CityBattle, useDriverControls, VEHICLES, type Vehicle } from "./game/VehicleScene";
import { toCommand } from "./input/intent";
import type { LatLon } from "./maps/city-cache";
import type { CityData } from "./maps/city-compiler";
import { parseCity } from "./maps/midtown";
import { loadLiveCity, type LiveCityOutcome } from "./maps/tile-city";
import { createCityMatch, PLAYER_ID } from "./sim/combat";
import { CONTRACT_VERSION, type CombatAuthority, type CombatSnapshot } from "./sim/contracts";
import { pushEvents, startLoop, type EventBus } from "./sim/world";
import { createPlaceSearch, type PlaceSearch } from "./ui/place-search";
import { DIFFICULTIES, type Difficulty } from "./sim/difficulty";
import { StartScreen, useStartFlow, type MapFactory } from "./ui/StartScreen";

const MATCH_SEED = 20261124;
/** Redraw the HUD this often (in ticks); the 3D view reads the match every frame regardless. */
const HUD_EVERY_TICKS = 4;

/** The compiled Midtown district ships inside the app; it is what a refused place falls back to, offline too. */
const PINNED_CITY: CityData | null = (() => {
  try { return parseCity(cityFile); }
  catch { return null; }
})();

/** Build a live city for a picked point from OpenFreeMap tiles, caching it on the device and reporting progress. */
async function loadLiveCityInBrowser(point: LatLon, report: (message: string) => void): Promise<LiveCityOutcome> {
  report("Preparing the map tile loader…");
  // Loaded on demand so the tile decoder stays out of the start screen's first load.
  const [{ fetchTileFeatures }, { createIndexedDbStore }] = await Promise.all([import("./maps/live-tiles"), import("./maps/city-cache")]);
  return loadLiveCity(point, {
    cache: createIndexedDbStore(),
    fetchTiles: async (request) => {
      report("Fetching map tiles…");
      const tiles = await fetchTileFeatures(request);
      report(`Building the city from ${tiles.features.length} map features…`);
      return tiles;
    },
  });
}

function CombatSurface({ city, vehicle, difficulty, controls, onChangePlace }: { city: CityData; vehicle: Vehicle; difficulty: Difficulty; controls: DrivingControls; onChangePlace: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<PageLifecycle | null>(null);
  const restartRef = useRef<() => void>(() => undefined);
  const bus = useRef<EventBus>({ events: [] });
  const [match, setMatch] = useState<CombatAuthority | null>(null);
  const [snapshot, setSnapshot] = useState<CombatSnapshot | null>(null);
  const [page, setPage] = useState<LifecycleState>(RUNNING);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current: CombatAuthority;
    try { current = createCityMatch(city, { seed: MATCH_SEED, playerVehicle: vehicle.id, difficulty }); }
    catch (error) { setFailure(error instanceof Error ? error.message : "The combat simulation could not start."); return undefined; }
    setFailure(null);
    setMatch(current);
    setSnapshot(current.snapshot());
    bus.current.events.length = 0;
    let shownTick = 0;
    let shownStatus = current.snapshot().match.status;
    const loop = startLoop(current, {
      sample: (target) => {
        // Keyboard, gamepad and touch all arrive as one intent.
        const now = current.snapshot();
        const intent = controls.sample(undefined, { tick: now.tick, speed: now.vehicles[0]!.speed });
        target.submitInput(toCommand(intent, now.tick, PLAYER_ID));
      },
      onFrame: (frame, ticks) => {
        // The one-shot weapons are spent only when a tick actually ran on the sampled intent; a frame that ran no
        // tick (a high refresh rate, or jitter) keeps the latch, so the next sample still carries the press.
        if (ticks > 0) controls.consume();
        const next = frame as CombatSnapshot;
        pushEvents(bus.current, current.drainEvents());
        if (next.tick - shownTick >= HUD_EVERY_TICKS || next.tick < shownTick || next.match.status !== shownStatus) {
          shownTick = next.tick;
          shownStatus = next.match.status;
          setSnapshot(next);
        }
      },
    });
    const runtime = bindMatchRuntime({ controls, match: current, loop, surface: stageRef.current, onChange: setPage });
    runtimeRef.current = runtime;
    setPage(runtime.state());
    restartRef.current = () => {
      controls.clear();
      current.restart();
      current.drainEvents();
      bus.current.events.length = 0;
      shownTick = 0;
      shownStatus = "running";
      // A restart is a tap, so it resumes too; it stays paused while there is nothing to draw with.
      runtime.resume();
      setSnapshot(current.snapshot());
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "r" || event.key === "R") { restartRef.current(); event.preventDefault(); }
    };
    window.addEventListener("keydown", keyDown);
    return () => {
      window.removeEventListener("keydown", keyDown);
      runtime.dispose();
      loop.stop();
      current.dispose();
      runtimeRef.current = null;
      restartRef.current = () => undefined;
    };
  }, [city, vehicle, difficulty, controls]);

  const rendererFailed = useCallback(() => runtimeRef.current?.rendererFailed(), []);
  const retryRenderer = useCallback(() => runtimeRef.current?.retry(), []);

  if (failure) return <section className="drive" aria-label="Combat city"><p role="alert" className="drive-error">The city fight could not start: {failure} <button type="button" onClick={onChangePlace}>Change place</button></p></section>;
  const player = snapshot?.vehicles.find((v) => v.playerId === PLAYER_ID);
  const hurt = snapshot && player && player.alive && snapshot.tick - player.lastHitTick < 12 && snapshot.match.status === "running";
  return <section className="drive" aria-label="Combat city">
    {snapshot && <Hud snapshot={snapshot} onRestart={() => restartRef.current()} />}
    <div ref={stageRef} className="drive-stage" style={{ position: "relative", maxWidth: "none" }}>
      {match && <CityBattle city={city} match={match} bus={bus} vehicle={vehicle} page={page} onRendererFailed={rendererFailed} onRetry={retryRenderer} />}
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, borderRadius: 12, pointerEvents: "none", boxShadow: hurt ? "inset 0 0 70px 18px rgba(232,60,40,0.55)" : "inset 0 0 0 0 rgba(232,60,40,0)", transition: "box-shadow 120ms ease-out" }} />
      <TouchControls controls={controls} />
      {snapshot && snapshot.match.status !== "running" && <div className="results" role="dialog" aria-label="Match results">
        <p>{snapshot.match.status === "won" ? "Victory" : "Wrecked"}</p>
        <p className="results-level">Difficulty: {DIFFICULTIES.find((d) => d.id === snapshot.match.difficulty)?.label ?? snapshot.match.difficulty}</p>
        <div className="results-actions"><button type="button" onClick={() => restartRef.current()}>Restart</button><button type="button" onClick={onChangePlace}>Change place</button></div>
      </div>}
      {page.paused && page.graphics === "ok" && <button type="button" className="resume" onClick={() => runtimeRef.current?.resume()}>Paused — tap to resume</button>}
    </div>
    <p className="drive-hint">On a phone, drag the left side to steer (drag down to reverse) and use the buttons on the right to brake and fire; Auto gas keeps you driving. On a keyboard, WASD or arrows drive, Space fires, Q fires a missile, E uses your special, Shift is the handbrake and R restarts. A gamepad works too.</p>
  </section>;
}

export interface AppProps {
  /** Replaces the live city loader (tests). */
  loadCity?: (point: LatLon, report: (message: string) => void) => Promise<LiveCityOutcome>;
  /** Replaces the Nominatim place search (tests). */
  search?: PlaceSearch;
  /** Replaces the MapLibre map (tests). */
  createMap?: MapFactory;
}

export default function App({ loadCity = loadLiveCityInBrowser, search, createMap }: AppProps) {
  const [selected, setSelected] = useState(0);
  const vehicle = VEHICLES[selected]!;
  // One controls adapter (keys, touch, gamepad) drives the city fight.
  const controls = useDriverControls();
  const [placeSearch] = useState<PlaceSearch>(() => search ?? createPlaceSearch());
  const flow = useStartFlow({ loadCity, pinned: PINNED_CITY });
  const { phase } = flow;
  return <main>
    <header><a className="arcade" href="https://www.oleyarcade.com/">← OleyArcade</a><span className="edition">{phase.name === "playing" ? phase.place.name : "Garage preview"}</span></header>
    {phase.name === "playing"
      ? <CombatSurface city={phase.city} vehicle={vehicle} difficulty={flow.difficulty} controls={controls} onChangePlace={flow.changePlace} />
      : <>
        <section className="intro" aria-labelledby="title"><p className="eyebrow">The world is your arena</p><h1 id="title">WRECK<span>TERRA</span></h1><p className="lede">Take the scenic route.<br/>Leave a wreck.</p></section>
        <StartScreen flow={flow} search={placeSearch} selected={selected} onSelectVehicle={setSelected} createMap={createMap} />
        <footer><strong>New York is up first.</strong><p>The driving prototype is in development. This garage lets you preview the original starter vehicles.</p></footer>
      </>}
  </main>;
}
