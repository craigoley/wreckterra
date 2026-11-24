import { Component, lazy, Suspense, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import type { CityData } from "../maps/city-compiler";
import { CITY_SPEED_SCALE } from "../maps/midtown";
import { VEHICLE_SPECS } from "../sim/arena";
import type { CombatAuthority } from "../sim/contracts";
import type { EventBus } from "../sim/world";

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

const COLORS: Record<string, string> = Object.fromEntries(VEHICLES.map((v) => [v.id, v.color]));

/**
 * The 3D view of a running city combat match. The match itself is owned and ticked by the caller;
 * this only draws it, loading the 3D code on demand and falling back to a message without WebGL.
 */
export function CityBattle({ city, match, bus, vehicle }: { city: CityData; match: CombatAuthority; bus: MutableRefObject<EventBus>; vehicle: Vehicle }) {
  const [webgl] = useState(webglAvailable);
  const maxSpeed = VEHICLE_SPECS[vehicle.id].maxSpeed * CITY_SPEED_SCALE;
  const body: ReactNode = webgl
    ? <SceneBoundary><Suspense fallback={<p role="status" style={noteStyle}>Loading the 3D view…</p>}>
      <CityScene key={vehicle.id} city={city} match={match} bus={bus} colors={COLORS} maxSpeed={maxSpeed} />
    </Suspense></SceneBoundary>
    : <p role="status" style={noteStyle}>The 3D city needs WebGL, which this browser is not offering. The match still runs; the garage below still works.</p>;
  return <div className="city-battle" style={stageStyle}>{body}</div>;
}
