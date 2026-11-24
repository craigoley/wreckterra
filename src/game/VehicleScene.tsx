import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { CityData } from "../maps/city-compiler";
import { createCityWorld, loadCity, CITY_SPEED_SCALE } from "../maps/midtown";
import { VEHICLE_SPECS } from "../sim/arena";
import type { Held } from "./TouchControls";

export const VEHICLES = [
  { id: "switchback", name: "Switchback", role: "All-rounder", color: "#e88b43", speed: 3, armor: 3 },
  { id: "rivet", name: "Rivet", role: "Heavy bruiser", color: "#9dad88", speed: 2, armor: 5 },
  { id: "voltage", name: "Voltage", role: "Agile interceptor", color: "#b2cfde", speed: 5, armor: 2 },
] as const;
export type Vehicle = (typeof VEHICLES)[number];

export function VehicleScene({ vehicle }: { vehicle: Vehicle }) {
  return <div className="vehicle-scene">
    <svg viewBox="0 0 600 330" role="img" aria-label={`${vehicle.name} vehicle preview`}>
      <ellipse cx="300" cy="270" rx="210" ry="25" fill="#080d0a" />
      <path d="M55 265H545M85 285H515M130 305H470" stroke="#47604c" strokeWidth="1" />
      <g stroke="#111a16" strokeWidth="6" strokeLinejoin="round">
        <path d="M130 210L185 175L405 175L475 215L465 250L135 250Z" fill={vehicle.color} />
        <path d="M200 175L240 120L350 120L400 175Z" fill={vehicle.color} />
        <path d="M243 130L265 130L265 169L215 169Z M278 130L344 130L380 169L278 169Z" fill="#273f38" />
        <path d="M140 218H465M170 202H220M390 202H440" fill="none" />
        <circle cx="205" cy="248" r="35" fill="#18201a" /><circle cx="405" cy="248" r="35" fill="#18201a" />
        <circle cx="205" cy="248" r="16" fill="#9aa59b" /><circle cx="405" cy="248" r="16" fill="#9aa59b" />
        <path d="M305 119V93H330V119" fill="#89968b" />
      </g>
    </svg>
    <span className="scene-caption">Original machines. Real-world arenas.</span>
  </div>;
}

const CityScene = lazy(() => import("./CityScene").then((m) => ({ default: m.CityScene })));

const CITY_SEED = 20261124;

/** Three.js needs WebGL; without it (an old browser, a test DOM) the city view shows a plain message instead. */
function webglAvailable(): boolean {
  return typeof WebGL2RenderingContext !== "undefined" || typeof WebGLRenderingContext !== "undefined";
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render(): ReactNode {
    return this.state.failed
      ? <p role="alert" style={noteStyle}>The 3D city view could not start on this device. Reload the page to try again.</p>
      : this.props.children;
  }
}

const noteStyle: CSSProperties = { margin: 0, padding: "1rem", textAlign: "center", color: "#d8e0d0" };
const stageStyle: CSSProperties = { position: "relative", width: "100%", aspectRatio: "16 / 10", minHeight: 260, maxHeight: "70vh", background: "#b9c7d4", borderRadius: 12, overflow: "hidden", border: "2px solid #47604c" };

type CityState = { status: "loading" } | { status: "ready"; city: CityData } | { status: "error"; message: string };

/**
 * Third-person drive through the compiled Midtown city. The city file is loaded here with
 * `loadCity(`, the car runs on the fixed-tick city world, and the 3D view is loaded on demand.
 */
export function CityDrive({ vehicle, held }: { vehicle: Vehicle; held: RefObject<Held> }) {
  const [webgl] = useState(webglAvailable);
  const [state, setState] = useState<CityState>({ status: "loading" });
  const speedo = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!webgl) return undefined;
    let live = true;
    loadCity()
      .then((city) => { if (live) setState({ status: "ready", city }); })
      .catch((error: unknown) => { if (live) setState({ status: "error", message: error instanceof Error ? error.message : "The city could not be loaded." }); });
    return () => { live = false; };
  }, [webgl]);

  const world = useMemo(() => (state.status === "ready" ? createCityWorld(state.city, { seed: CITY_SEED, vehicle: vehicle.id }) : null), [state, vehicle.id]);
  useEffect(() => () => world?.dispose(), [world]);

  const maxSpeed = VEHICLE_SPECS[vehicle.id].maxSpeed * CITY_SPEED_SCALE;
  let body: ReactNode;
  if (!webgl) body = <p role="status" style={noteStyle}>The 3D city needs WebGL, which this browser is not offering. The garage and arena below still work.</p>;
  else if (state.status === "error") body = <p role="alert" style={noteStyle}>Midtown could not be loaded: {state.message} Reload the page to try again.</p>;
  else if (!world || state.status !== "ready") body = <p role="status" style={noteStyle}>Loading Midtown…</p>;
  else {
    body = <SceneBoundary><Suspense fallback={<p role="status" style={noteStyle}>Loading the 3D view…</p>}>
      <CityScene city={state.city} world={world} held={held} color={vehicle.color} maxSpeed={maxSpeed} speedo={speedo} />
    </Suspense></SceneBoundary>;
  }
  return <section className="city-drive" aria-label="Midtown drive" style={{ margin: "1rem 0" }}>
    <div style={stageStyle}>
      {body}
      {world && <span ref={speedo} aria-label="Speed" style={{ position: "absolute", left: 12, top: 10, fontWeight: 700, fontSize: 20, color: "#fff", textShadow: "0 1px 3px #000" }}>0 km/h</span>}
      {world && <button type="button" onClick={() => world.reset()} style={{ position: "absolute", right: 12, top: 10, minHeight: 36, padding: "6px 10px" }}>Reset car</button>}
    </div>
  </section>;
}
