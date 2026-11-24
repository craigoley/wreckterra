import { useEffect, useRef, useState } from "react";
import cityFile from "../public/maps/midtown/city.json";
import { Hud } from "./game/Hud";
import { IDLE, KEYS, TouchControls, type Held } from "./game/TouchControls";
import { CityBattle, VehicleScene, VEHICLES, type Vehicle } from "./game/VehicleScene";
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

function CombatSurface({ vehicle, held }: { vehicle: Vehicle; held: { current: Held } }) {
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
    const clear = () => { held.current = { ...IDLE }; };
    const loop = startLoop(current, {
      sample: (target) => {
        const pad = typeof navigator.getGamepads === "function" ? navigator.getGamepads()[0] : null;
        const h = held.current;
        const keyed = (h.right ? 1 : 0) - (h.left ? 1 : 0);
        const drive = (h.gas ? 1 : 0) - (h.reverse ? 1 : 0);
        const steer = keyed !== 0 || !pad ? keyed : Math.abs(pad.axes[0] ?? 0) > 0.15 ? pad.axes[0] : 0;
        const throttle = drive !== 0 || !pad ? drive : (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
        target.submitInput({ v: CONTRACT_VERSION, tick: target.snapshot().tick, playerId: PLAYER_ID,
          steer: Math.max(-1, Math.min(1, steer)), throttle: Math.max(-1, Math.min(1, throttle)),
          brake: h.brake || Boolean(pad?.buttons[3]?.pressed),
          fire: h.fire || Boolean(pad?.buttons[0]?.pressed), missile: h.missile || Boolean(pad?.buttons[1]?.pressed),
          special: h.special || Boolean(pad?.buttons[2]?.pressed) });
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
    const onKey = (down: boolean) => (event: KeyboardEvent) => {
      if (down && (event.key === "r" || event.key === "R")) { restartRef.current(); event.preventDefault(); return; }
      const control = KEYS[event.key];
      if (!control) return;
      held.current[control] = down;
      event.preventDefault();
    };
    const keyDown = onKey(true);
    const keyUp = onKey(false);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", clear);
    window.addEventListener("orientationchange", clear);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", clear);
      window.removeEventListener("orientationchange", clear);
      loop.stop();
      current.dispose();
      loopRef.current = null;
      restartRef.current = () => undefined;
      clear();
    };
  }, [vehicle, held]);

  if (failure || "error" in DISTRICT) return <section className="drive" aria-label="Combat city"><p role="alert" className="drive-error">The city fight could not start: {failure} Reload the page to try again.</p></section>;
  const player = snapshot?.vehicles.find((v) => v.playerId === PLAYER_ID);
  const hurt = snapshot && player && player.alive && snapshot.tick - player.lastHitTick < 12 && snapshot.match.status === "running";
  return <section className="drive" aria-label="Combat city">
    {snapshot && <Hud snapshot={snapshot} onRestart={() => restartRef.current()} />}
    <div className="drive-stage" style={{ position: "relative", maxWidth: "none" }}>
      {match && <CityBattle city={DISTRICT.city} match={match} bus={bus} vehicle={vehicle} />}
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, borderRadius: 12, pointerEvents: "none", boxShadow: hurt ? "inset 0 0 70px 18px rgba(232,60,40,0.55)" : "inset 0 0 0 0 rgba(232,60,40,0)", transition: "box-shadow 120ms ease-out" }} />
      {paused && <button type="button" className="resume" onClick={() => { loopRef.current?.resume(); setPaused(false); }}>Paused — tap to resume</button>}
    </div>
    <TouchControls held={held} />
    <p className="drive-hint">Touch the pads, or use arrows/WASD to drive, Space or J to fire, K for a missile, L for your special, R to restart. A gamepad works too.</p>
  </section>;
}

export default function App() {
  const [selected, setSelected] = useState(0);
  const vehicle = VEHICLES[selected];
  // One set of controls (keys, touch pads, gamepad) drives the city fight.
  const held = useRef<Held>({ ...IDLE });
  return <main>
    <header><a className="arcade" href="https://www.oleyarcade.com/">← OleyArcade</a><span className="edition">Garage preview</span></header>
    <section className="intro" aria-labelledby="title"><p className="eyebrow">The world is your arena</p><h1 id="title">WRECK<span>TERRA</span></h1><p className="lede">Take the scenic route.<br/>Leave a wreck.</p></section>
    <CombatSurface vehicle={vehicle} held={held} />
    <section className="garage" aria-label="Vehicle garage"><VehicleScene vehicle={vehicle} />
      <div className="vehicle-heading"><div><p className="eyebrow">Your ride</p><h2>{vehicle.name}</h2></div><p>{vehicle.role}</p></div>
      <div className="choices" role="group" aria-label="Choose a vehicle">{VEHICLES.map((item, index) => <button key={item.id} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}><span>{item.name}</span><small>{item.role}</small></button>)}</div>
      <dl className="stats" aria-live="polite"><div><dt>Speed</dt><dd>{vehicle.speed} / 5</dd></div><div><dt>Armor</dt><dd>{vehicle.armor} / 5</dd></div><div><dt>First arena</dt><dd>Central Park</dd></div></dl>
    </section>
    <footer><strong>New York is up first.</strong><p>The driving prototype is in development. This garage lets you preview the original starter vehicles.</p></footer>
  </main>;
}
