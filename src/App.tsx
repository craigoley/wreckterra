import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { VehicleScene, VEHICLES, type Vehicle } from "./game/VehicleScene";
import { CONTRACT_VERSION, type ArenaLayout, type LocalAuthority } from "./sim/contracts";
import { createWorld, startLoop, type LoopHandle } from "./sim/world";

const MATCH_SEED = 20261025;
type Held = { left: boolean; right: boolean; gas: boolean; reverse: boolean; brake: boolean };
const IDLE: Held = { left: false, right: false, gas: false, reverse: false, brake: false };
const KEYS: Record<string, keyof Held> = {
  ArrowLeft: "left", a: "left", A: "left", ArrowRight: "right", d: "right", D: "right",
  ArrowUp: "gas", w: "gas", W: "gas", ArrowDown: "reverse", s: "reverse", S: "reverse", " ": "brake",
};

function HoldButton({ label, control, held }: { label: string; control: keyof Held; held: { current: Held } }) {
  const press = (event: ReactPointerEvent<HTMLButtonElement>) => { event.currentTarget.setPointerCapture?.(event.pointerId); held.current[control] = true; };
  const release = () => { held.current[control] = false; };
  return <button type="button" className={`hold hold-${control}`} onPointerDown={press} onPointerUp={release} onPointerCancel={release}
    onLostPointerCapture={release} onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => { if (event.key === "Enter") held.current[control] = true; }} onKeyUp={() => release()}>{label}</button>;
}

function DrivingSurface({ vehicle }: { vehicle: Vehicle }) {
  const held = useRef<Held>({ ...IDLE });
  const carRef = useRef<SVGGElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const loopRef = useRef<LoopHandle | null>(null);
  const [layout, setLayout] = useState<ArenaLayout | null>(null);
  const [paused, setPaused] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let world: LocalAuthority;
    try { world = createWorld({ seed: MATCH_SEED, maxSpeed: 8 + vehicle.speed * 4 }); }
    catch (error) { setFailure(error instanceof Error ? error.message : "The driving simulation could not start."); return; }
    setFailure(null);
    setLayout(world.layout);
    const clear = () => { held.current = { ...IDLE }; };
    const loop = startLoop(world, {
      sample: (target) => {
        const pad = typeof navigator.getGamepads === "function" ? navigator.getGamepads()[0] : null;
        const h = held.current;
        const keyed = (h.right ? 1 : 0) - (h.left ? 1 : 0);
        const drive = (h.gas ? 1 : 0) - (h.reverse ? 1 : 0);
        const steer = keyed !== 0 || !pad ? keyed : Math.abs(pad.axes[0] ?? 0) > 0.15 ? pad.axes[0] : 0;
        const throttle = drive !== 0 || !pad ? drive : (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
        target.submitInput({ v: CONTRACT_VERSION, tick: target.snapshot().tick, playerId: "player-1",
          steer: Math.max(-1, Math.min(1, steer)), throttle: Math.max(-1, Math.min(1, throttle)), brake: h.brake || Boolean(pad?.buttons[0]?.pressed) });
      },
      onFrame: (snapshot) => {
        const car = snapshot.vehicles[0];
        carRef.current?.setAttribute("transform", `translate(${car.x.toFixed(3)} ${car.z.toFixed(3)}) rotate(${(-car.heading * 180 / Math.PI).toFixed(2)})`);
        if (readoutRef.current) readoutRef.current.textContent = `${Math.round(Math.abs(car.speed) * 3.6)} km/h`;
      },
    });
    loopRef.current = loop;
    setPaused(false);
    const onHidden = () => { if (document.hidden) { clear(); loop.pause(); setPaused(true); } };
    const onKey = (down: boolean) => (event: KeyboardEvent) => {
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
      world.dispose();
      loopRef.current = null;
      clear();
    };
  }, [vehicle]);

  if (failure) return <section className="drive" aria-label="Driving arena"><p role="alert" className="drive-error">The driving arena could not start: {failure} Reload the page to try again.</p></section>;
  const half = layout?.halfExtent ?? 40;
  return <section className="drive" aria-label="Driving arena">
    <div className="drive-stage">
      <svg viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`} role="img" aria-label={`Top-down practice arena. You are driving ${vehicle.name}.`}>
        <rect x={-half} y={-half} width={half * 2} height={half * 2} className="arena-floor" />
        {layout?.obstacles.map((o, index) => <rect key={index} x={o.x - o.halfX} y={o.z - o.halfZ} width={o.halfX * 2} height={o.halfZ * 2} className="arena-block" />)}
        <g ref={carRef}><polygon points="0,2 -1.2,-1.6 1.2,-1.6" fill={vehicle.color} stroke="#111a16" strokeWidth="0.3" /></g>
      </svg>
      {paused && <button type="button" className="resume" onClick={() => { loopRef.current?.resume(); setPaused(false); }}>Paused — tap to resume</button>}
    </div>
    <p className="drive-status" aria-live="polite">Practice arena · <span ref={readoutRef}>0 km/h</span></p>
    <div className="pad" role="group" aria-label="Driving controls">
      <HoldButton label="◀ Left" control="left" held={held} /><HoldButton label="Right ▶" control="right" held={held} />
      <HoldButton label="Gas" control="gas" held={held} /><HoldButton label="Reverse" control="reverse" held={held} /><HoldButton label="Brake" control="brake" held={held} />
    </div>
    <p className="drive-hint">Touch the pads, use arrow keys or WASD with Space to brake, or plug in a gamepad.</p>
  </section>;
}

export default function App() {
  const [selected, setSelected] = useState(0);
  const vehicle = VEHICLES[selected];
  return <main>
    <header><a className="arcade" href="https://www.oleyarcade.com/">← OleyArcade</a><span className="edition">Garage preview</span></header>
    <section className="intro" aria-labelledby="title"><p className="eyebrow">The world is your arena</p><h1 id="title">WRECK<span>TERRA</span></h1><p className="lede">Take the scenic route.<br/>Leave a wreck.</p></section>
    <DrivingSurface vehicle={vehicle} />
    <section className="garage" aria-label="Vehicle garage"><VehicleScene vehicle={vehicle} />
      <div className="vehicle-heading"><div><p className="eyebrow">Your ride</p><h2>{vehicle.name}</h2></div><p>{vehicle.role}</p></div>
      <div className="choices" role="group" aria-label="Choose a vehicle">{VEHICLES.map((item, index) => <button key={item.id} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}><span>{item.name}</span><small>{item.role}</small></button>)}</div>
      <dl className="stats" aria-live="polite"><div><dt>Speed</dt><dd>{vehicle.speed} / 5</dd></div><div><dt>Armor</dt><dd>{vehicle.armor} / 5</dd></div><div><dt>First arena</dt><dd>Central Park</dd></div></dl>
    </section>
    <footer><strong>New York is up first.</strong><p>The driving prototype is in development. This garage lets you preview the original starter vehicles.</p></footer>
  </main>;
}
