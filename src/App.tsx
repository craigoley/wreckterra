import { useEffect, useRef, useState } from "react";
import cityFile from "../public/maps/midtown/city.json";
import { Garage, RewardSummary } from "./game/Garage";
import { Hud } from "./game/Hud";
import { TouchControls } from "./game/TouchControls";
import { CityBattle, useDriverControls, VEHICLES, type Vehicle } from "./game/VehicleScene";
import type { Controls } from "./input/controls";
import { toCommand } from "./input/intent";
import type { LatLon } from "./maps/city-cache";
import type { CityData } from "./maps/city-compiler";
import { parseCity } from "./maps/midtown";
import { loadLiveCity, type LiveCityOutcome } from "./maps/tile-city";
import { createProgressStore, saveOnInterruption, type ProgressStore } from "./progress/profile";
import { awardMatch, newMatchId, type Award } from "./progress/rewards";
import { createCityMatch, PLAYER_ID } from "./sim/combat";
import { CONTRACT_VERSION, type CombatAuthority, type CombatSnapshot } from "./sim/contracts";
import { pushEvents, startLoop, type EventBus, type LoopHandle } from "./sim/world";
import { createPlaceSearch, type Place, type PlaceSearch } from "./ui/place-search";
import { DIFFICULTIES, type Difficulty } from "./sim/difficulty";
import { StartScreen, SUGGESTED_PLACES, useStartFlow, type MapFactory } from "./ui/StartScreen";

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

/** The passport name of a curated place; a dropped pin or a search result has none. */
function passportName(place: Place): string | null {
  return SUGGESTED_PLACES.find((p) => p.name === place.name && p.lat === place.lat && p.lon === place.lon)?.name ?? null;
}

/** Reward each play of a match once, as soon as it ends. Returns the reward to show, or null while running. */
function useMatchReward(progress: ProgressStore, snapshot: CombatSnapshot | null, vehicle: Vehicle, place: Place): Award | null {
  const playId = useRef<string | null>(null);
  const [award, setAward] = useState<Award | null>(null);
  const status = snapshot?.match.status;
  useEffect(() => {
    if (!snapshot) return;
    // A running match is a new play: the next result gets its own id.
    if (snapshot.match.status === "running") { playId.current = null; setAward(null); return; }
    playId.current ??= newMatchId();
    setAward(awardMatch(progress, {
      matchId: playId.current,
      vehicle: vehicle.id,
      status: snapshot.match.status,
      reason: snapshot.match.reason,
      ticks: snapshot.match.endedTick ?? snapshot.tick,
      passport: passportName(place),
    }));
    // Keyed on the status alone: later snapshots of an ended match are the same result.
  }, [status]);
  return award;
}

function CombatSurface({ city, place, vehicle, difficulty, controls, progress, onChangePlace }: { city: CityData; place: Place; vehicle: Vehicle; difficulty: Difficulty; controls: Controls; progress: ProgressStore; onChangePlace: () => void }) {
  const loopRef = useRef<LoopHandle | null>(null);
  const restartRef = useRef<() => void>(() => undefined);
  const bus = useRef<EventBus>({ events: [] });
  const [match, setMatch] = useState<CombatAuthority | null>(null);
  const [snapshot, setSnapshot] = useState<CombatSnapshot | null>(null);
  const [paused, setPaused] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const award = useMatchReward(progress, snapshot, vehicle, place);

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
    const clear = () => controls.clear();
    const loop = startLoop(current, {
      sample: (target) => {
        // Keyboard, gamepad and touch all arrive as one intent.
        target.submitInput(toCommand(controls.sample(), target.snapshot().tick, PLAYER_ID));
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
    loopRef.current = loop;
    setPaused(false);
    restartRef.current = () => {
      clear();
      current.restart();
      current.drainEvents();
      bus.current.events.length = 0;
      shownTick = 0;
      shownStatus = "running";
      loop.resume();
      setPaused(false);
      setSnapshot(current.snapshot());
    };
    const onHidden = () => { if (document.hidden) { clear(); loop.pause(); setPaused(true); } };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "r" || event.key === "R") { restartRef.current(); event.preventDefault(); }
    };
    const detachControls = controls.attach();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("blur", clear);
    window.addEventListener("orientationchange", clear);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("keydown", keyDown);
      detachControls();
      window.removeEventListener("blur", clear);
      window.removeEventListener("orientationchange", clear);
      loop.stop();
      current.dispose();
      loopRef.current = null;
      restartRef.current = () => undefined;
      clear();
    };
  }, [city, vehicle, difficulty, controls]);

  if (failure) return <section className="drive" aria-label="Combat city"><p role="alert" className="drive-error">The city fight could not start: {failure} <button type="button" onClick={onChangePlace}>Change place</button></p></section>;
  const player = snapshot?.vehicles.find((v) => v.playerId === PLAYER_ID);
  const hurt = snapshot && player && player.alive && snapshot.tick - player.lastHitTick < 12 && snapshot.match.status === "running";
  return <section className="drive" aria-label="Combat city">
    {snapshot && <Hud snapshot={snapshot} onRestart={() => restartRef.current()} />}
    <div className="drive-stage" style={{ position: "relative", maxWidth: "none" }}>
      {match && <CityBattle city={city} match={match} bus={bus} vehicle={vehicle} />}
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, borderRadius: 12, pointerEvents: "none", boxShadow: hurt ? "inset 0 0 70px 18px rgba(232,60,40,0.55)" : "inset 0 0 0 0 rgba(232,60,40,0)", transition: "box-shadow 120ms ease-out" }} />
      <TouchControls controls={controls} />
      {snapshot && snapshot.match.status !== "running" && <div className="results" role="dialog" aria-label="Match results">
        <p>{snapshot.match.status === "won" ? "Victory" : "Wrecked"}</p>
        <p className="results-level">Difficulty: {DIFFICULTIES.find((d) => d.id === snapshot.match.difficulty)?.label ?? snapshot.match.difficulty}</p>
        {award && <RewardSummary store={progress} award={award} />}
        <div className="results-actions"><button type="button" onClick={() => restartRef.current()}>Restart</button><button type="button" onClick={onChangePlace}>Change place</button></div>
      </div>}
      {paused && <button type="button" className="resume" onClick={() => { loopRef.current?.resume(); setPaused(false); }}>Paused — tap to resume</button>}
    </div>
    <p className="drive-hint">On a phone, drag the left side to steer (drag down to reverse) and use the buttons on the right to fire. On a keyboard, WASD or arrows drive, Space fires, Q fires a missile, E uses your special, Shift is the handbrake and R restarts. A gamepad works too.</p>
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
  // Progress lives here, above the match and its renderer, so neither can take it down with them.
  const [progress] = useState(() => createProgressStore());
  useEffect(() => saveOnInterruption(progress), [progress]);
  const leaveMatch = () => { progress.save(); flow.changePlace(); };
  return <main>
    <header><a className="arcade" href="https://www.oleyarcade.com/">← OleyArcade</a><span className="edition">{phase.name === "playing" ? phase.place.name : "Garage preview"}</span></header>
    {phase.name === "playing"
      ? <CombatSurface city={phase.city} place={phase.place} vehicle={vehicle} difficulty={flow.difficulty} controls={controls} progress={progress} onChangePlace={leaveMatch} />
      : <>
        <section className="intro" aria-labelledby="title"><p className="eyebrow">The world is your arena</p><h1 id="title">WRECK<span>TERRA</span></h1><p className="lede">Take the scenic route.<br/>Leave a wreck.</p></section>
        <StartScreen flow={flow} search={placeSearch} selected={selected} onSelectVehicle={setSelected} createMap={createMap} />
        {phase.name === "start" && <Garage store={progress} />}
        <footer><strong>New York is up first.</strong><p>The driving prototype is in development. This garage lets you preview the original starter vehicles.</p></footer>
      </>}
  </main>;
}
