import { useEffect, useRef, useState } from "react";
import { ArenaScene, fxFromEvents, liveFx, type Fx } from "./game/ArenaScene";
import { Hud } from "./game/Hud";
import { IDLE, KEYS, TouchControls, type Held } from "./game/TouchControls";
import { CityDrive, VehicleScene, VEHICLES, type Vehicle } from "./game/VehicleScene";
import { createCombatMatch, PLAYER_ID } from "./sim/combat";
import { CONTRACT_VERSION, type CombatArenaLayout, type CombatAuthority, type CombatSnapshot } from "./sim/contracts";
import { startLoop, type LoopHandle } from "./sim/world";

const MATCH_SEED = 20261025;

interface Frame {
  snapshot: CombatSnapshot;
  fx: Fx[];
}

function CombatSurface({ vehicle, held }: { vehicle: Vehicle; held: { current: Held } }) {
  const loopRef = useRef<LoopHandle | null>(null);
  const restartRef = useRef<() => void>(() => undefined);
  const [layout, setLayout] = useState<CombatArenaLayout | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [paused, setPaused] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let match: CombatAuthority;
    try { match = createCombatMatch({ seed: MATCH_SEED, playerVehicle: vehicle.id }); }
    catch (error) { setFailure(error instanceof Error ? error.message : "The combat simulation could not start."); return; }
    setFailure(null);
    setLayout(match.layout);
    setFrame({ snapshot: match.snapshot(), fx: [] });
    let fx: Fx[] = [];
    const clear = () => { held.current = { ...IDLE }; };
    const loop = startLoop(match, {
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
      onFrame: (snapshot) => {
        fx = liveFx([...fx, ...fxFromEvents(match.drainEvents())], snapshot.tick);
        setFrame({ snapshot: snapshot as CombatSnapshot, fx });
      },
    });
    loopRef.current = loop;
    setPaused(false);
    restartRef.current = () => {
      clear();
      fx = [];
      match.restart();
      loop.resume();
      setPaused(false);
      setFrame({ snapshot: match.snapshot(), fx: [] });
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
      match.dispose();
      loopRef.current = null;
      restartRef.current = () => undefined;
      clear();
    };
  }, [vehicle, held]);

  if (failure) return <section className="drive" aria-label="Combat arena"><p role="alert" className="drive-error">The combat arena could not start: {failure} Reload the page to try again.</p></section>;
  const player = frame?.snapshot.vehicles.find((v) => v.playerId === PLAYER_ID);
  const shaking = frame && player && frame.snapshot.tick - player.lastHitTick < 8 && frame.snapshot.match.status === "running";
  return <section className="drive" aria-label="Combat arena">
    {frame && <Hud snapshot={frame.snapshot} onRestart={() => restartRef.current()} />}
    <div className={`drive-stage${shaking ? " shake" : ""}`}>
      {frame && layout && <ArenaScene snapshot={frame.snapshot} layout={layout} fx={frame.fx} vehicleName={vehicle.name} />}
      {paused && <button type="button" className="resume" onClick={() => { loopRef.current?.resume(); setPaused(false); }}>Paused — tap to resume</button>}
    </div>
    <TouchControls held={held} />
    <p className="drive-hint">Touch the pads, or use arrows/WASD to drive, Space or J to fire, K for a missile, L for your special, R to restart. A gamepad works too.</p>
  </section>;
}

export default function App() {
  const [selected, setSelected] = useState(0);
  const vehicle = VEHICLES[selected];
  // One set of controls (keys, touch pads, gamepad) drives both the city and the arena preview.
  const held = useRef<Held>({ ...IDLE });
  return <main>
    <header><a className="arcade" href="https://www.oleyarcade.com/">← OleyArcade</a><span className="edition">Garage preview</span></header>
    <section className="intro" aria-labelledby="title"><p className="eyebrow">The world is your arena</p><h1 id="title">WRECK<span>TERRA</span></h1><p className="lede">Take the scenic route.<br/>Leave a wreck.</p></section>
    <CityDrive vehicle={vehicle} held={held} />
    <p className="eyebrow" style={{ textAlign: "center" }}>Arena preview · weapons move into the city next</p>
    <CombatSurface vehicle={vehicle} held={held} />
    <section className="garage" aria-label="Vehicle garage"><VehicleScene vehicle={vehicle} />
      <div className="vehicle-heading"><div><p className="eyebrow">Your ride</p><h2>{vehicle.name}</h2></div><p>{vehicle.role}</p></div>
      <div className="choices" role="group" aria-label="Choose a vehicle">{VEHICLES.map((item, index) => <button key={item.id} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}><span>{item.name}</span><small>{item.role}</small></button>)}</div>
      <dl className="stats" aria-live="polite"><div><dt>Speed</dt><dd>{vehicle.speed} / 5</dd></div><div><dt>Armor</dt><dd>{vehicle.armor} / 5</dd></div><div><dt>First arena</dt><dd>Central Park</dd></div></dl>
    </section>
    <footer><strong>New York is up first.</strong><p>The driving prototype is in development. This garage lets you preview the original starter vehicles.</p></footer>
  </main>;
}
