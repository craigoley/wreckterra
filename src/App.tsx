import { useEffect, useRef, useState } from "react";
import cityFile from "../public/maps/midtown/city.json";
import { Hud } from "./game/Hud";
import { TouchControls } from "./game/TouchControls";
import { CityBattle, useDriverControls, VehicleScene, VEHICLES, type Vehicle } from "./game/VehicleScene";
import type { Controls } from "./input/controls";
import { toCommand } from "./input/intent";
import type { CityData } from "./maps/city-compiler";
import { parseCity } from "./maps/midtown";
import { createCityMatch, PLAYER_ID } from "./sim/combat";
import { CONTRACT_VERSION, type CombatAuthority, type CombatSnapshot } from "./sim/contracts";
import { pushEvents, startLoop, type EventBus, type LoopHandle } from "./sim/world";

const MATCH_SEED = 20261124;
/** Redraw the HUD this often (in ticks); the 3D view reads the match every frame regardless. */
const HUD_EVERY_TICKS = 4;

/** The compiled Midtown district ships inside the app, so a match can start on the first frame and offline. */
const DISTRICT: { city: CityData } | { error: string } = (() => {
  try { return { city: parseCity(cityFile) }; }
  catch (error) { return { error: error instanceof Error ? error.message : "The city could not be read." }; }
})();

function CombatSurface({ vehicle, controls }: { vehicle: Vehicle; controls: Controls }) {
  const loopRef = useRef<LoopHandle | null>(null);
  const restartRef = useRef<() => void>(() => undefined);
  const bus = useRef<EventBus>({ events: [] });
  const [match, setMatch] = useState<CombatAuthority | null>(null);
  const [snapshot, setSnapshot] = useState<CombatSnapshot | null>(null);
  const [paused, setPaused] = useState(false);
  const [failure, setFailure] = useState<string | null>("error" in DISTRICT ? DISTRICT.error : null);

  useEffect(() => {
    if ("error" in DISTRICT) return undefined;
    let current: CombatAuthority;
    try { current = createCityMatch(DISTRICT.city, { seed: MATCH_SEED, playerVehicle: vehicle.id }); }
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
        // Keyboard, gamepad and touch all arrive as one intent; the one-shot weapons are spent once the tick takes them.
        target.submitInput(toCommand(controls.sample(), target.snapshot().tick, PLAYER_ID));
        controls.consume();
      },
      onFrame: (frame) => {
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
  }, [vehicle, controls]);

  if (failure || "error" in DISTRICT) return <section className="drive" aria-label="Combat city"><p role="alert" className="drive-error">The city fight could not start: {failure} Reload the page to try again.</p></section>;
  const player = snapshot?.vehicles.find((v) => v.playerId === PLAYER_ID);
  const hurt = snapshot && player && player.alive && snapshot.tick - player.lastHitTick < 12 && snapshot.match.status === "running";
  return <section className="drive" aria-label="Combat city">
    {snapshot && <Hud snapshot={snapshot} onRestart={() => restartRef.current()} />}
    <div className="drive-stage" style={{ position: "relative", maxWidth: "none" }}>
      {match && <CityBattle city={DISTRICT.city} match={match} bus={bus} vehicle={vehicle} />}
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, borderRadius: 12, pointerEvents: "none", boxShadow: hurt ? "inset 0 0 70px 18px rgba(232,60,40,0.55)" : "inset 0 0 0 0 rgba(232,60,40,0)", transition: "box-shadow 120ms ease-out" }} />
      <TouchControls controls={controls} />
      {paused && <button type="button" className="resume" onClick={() => { loopRef.current?.resume(); setPaused(false); }}>Paused — tap to resume</button>}
    </div>
    <p className="drive-hint">On a phone, drag the left side to steer (drag down to reverse) and use the buttons on the right to fire. On a keyboard, WASD or arrows drive, Space fires, Q fires a missile, E uses your special, Shift is the handbrake and R restarts. A gamepad works too.</p>
  </section>;
}

export default function App() {
  const [selected, setSelected] = useState(0);
  const vehicle = VEHICLES[selected];
  // One controls adapter (keys, touch, gamepad) drives the city fight.
  const controls = useDriverControls();
  return <main>
    <header><a className="arcade" href="https://www.oleyarcade.com/">← OleyArcade</a><span className="edition">Garage preview</span></header>
    <section className="intro" aria-labelledby="title"><p className="eyebrow">The world is your arena</p><h1 id="title">WRECK<span>TERRA</span></h1><p className="lede">Take the scenic route.<br/>Leave a wreck.</p></section>
    <CombatSurface vehicle={vehicle} controls={controls} />
    <section className="garage" aria-label="Vehicle garage"><VehicleScene vehicle={vehicle} />
      <div className="vehicle-heading"><div><p className="eyebrow">Your ride</p><h2>{vehicle.name}</h2></div><p>{vehicle.role}</p></div>
      <div className="choices" role="group" aria-label="Choose a vehicle">{VEHICLES.map((item, index) => <button key={item.id} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}><span>{item.name}</span><small>{item.role}</small></button>)}</div>
      <dl className="stats" aria-live="polite"><div><dt>Speed</dt><dd>{vehicle.speed} / 5</dd></div><div><dt>Armor</dt><dd>{vehicle.armor} / 5</dd></div><div><dt>First arena</dt><dd>Central Park</dd></div></dl>
    </section>
    <footer><strong>New York is up first.</strong><p>The driving prototype is in development. This garage lets you preview the original starter vehicles.</p></footer>
  </main>;
}
