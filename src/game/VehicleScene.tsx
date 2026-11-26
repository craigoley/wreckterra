import { Component, lazy, Suspense, useEffect, useMemo, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import { IDLE_INTENT, toCommand } from "../input/intent";
import type { CityData } from "../maps/city-compiler";
import { CITY_SPEED_SCALE } from "../maps/midtown";
import { VEHICLE_SPECS } from "../sim/arena";
import type { CombatAuthority } from "../sim/contracts";
import type { EventBus, LoopHandle } from "../sim/world";
import { bindDrivingInput, createDrivingControls, type DrivingControls } from "./input";
import { bindPageLifecycle, type LifecycleState, type PageLifecycle } from "./lifecycle";

export const VEHICLES = [
  { id: "switchback", name: "Switchback", role: "All-rounder", color: "#e88b43", speed: 3, armor: 3 },
  { id: "rivet", name: "Rivet", role: "Heavy bruiser", color: "#9dad88", speed: 2, armor: 5 },
  { id: "voltage", name: "Voltage", role: "Agile interceptor", color: "#b2cfde", speed: 5, armor: 2 },
] as const;
export type Vehicle = (typeof VEHICLES)[number];

/** The one controls adapter for a match: keyboard, gamepad and touch all arrive as the same intent. */
export function useDriverControls(): DrivingControls {
  const [controls] = useState(() => createDrivingControls());
  return controls;
}

export interface MatchRuntime {
  controls: DrivingControls;
  match: CombatAuthority;
  loop: LoopHandle;
  /** The element holding the 3D view and the touch controls. */
  surface: Element | null;
  onChange: (state: LifecycleState) => void;
}

/**
 * Wire one running match to the page: every interruption releases the held controls in the simulation
 * as well as on screen, and a hidden page or lost graphics holds the match until the player resumes.
 */
export function bindMatchRuntime({ controls, match, loop, surface, onChange }: MatchRuntime): PageLifecycle {
  const playerId = match.snapshot().vehicles[0]!.playerId;
  const detachInput = bindDrivingInput(controls, {
    surface,
    onRelease: () => { match.submitInput(toCommand(IDLE_INTENT, match.snapshot().tick, playerId)); },
  });
  const lifecycle = bindPageLifecycle({ loop, surface, onChange, onPause: () => controls.clear() });
  return { ...lifecycle, dispose: () => { lifecycle.dispose(); detachInput(); } };
}

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

const lazyCityScene = () => lazy(() => import("./CityScene").then((m) => ({ default: m.CityScene })));
const FirstCityScene = lazyCityScene();

/** Three.js needs WebGL: an old browser, a blocked GPU or a test DOM has no context to give. */
function webglAvailable(): boolean {
  if (typeof WebGL2RenderingContext === "undefined" && typeof WebGLRenderingContext === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    // Hand the probe's context straight back: a phone allows only a few at once.
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return context !== null;
  } catch (error) {
    console.warn("WebGL could not be started.", error);
    return false;
  }
}

class SceneBoundary extends Component<{ onFailed: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(): void { this.props.onFailed(); }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const noteStyle: CSSProperties = { margin: 0, padding: "1rem", textAlign: "center", color: "#d8e0d0" };
/** Size lives in styles.css (.city-battle) so a portrait phone can give the city most of the screen. */
const stageStyle: CSSProperties = { position: "relative", width: "100%", background: "#b9c7d4", borderRadius: 12, overflow: "hidden", border: "2px solid #47604c" };

const COLORS: Record<string, string> = Object.fromEntries(VEHICLES.map((v) => [v.id, v.color]));

export interface CityBattleProps {
  city: CityData;
  match: CombatAuthority;
  bus: MutableRefObject<EventBus>;
  vehicle: Vehicle;
  /** The renderer's health, from the page lifecycle. */
  page: LifecycleState;
  onRendererFailed: () => void;
  onRetry: () => void;
}

/**
 * The 3D view of a running city combat match. The match itself is owned and ticked by the caller;
 * this only draws it, loading the 3D code on demand. When the view cannot be drawn it offers a retry,
 * which builds a fresh renderer over the same match.
 */
export function CityBattle({ city, match, bus, vehicle, page, onRendererFailed, onRetry }: CityBattleProps) {
  const { renderer } = page;
  // Each retry asks the browser again and loads the 3D code afresh.
  const webgl = useMemo(webglAvailable, [renderer]);
  const CityScene = useMemo(() => (renderer === 0 ? FirstCityScene : lazyCityScene()), [renderer]);
  useEffect(() => { if (!webgl) onRendererFailed(); }, [webgl, renderer, match, onRendererFailed]);
  const maxSpeed = VEHICLE_SPECS[vehicle.id].maxSpeed * CITY_SPEED_SCALE;
  return <div className="city-battle" style={stageStyle}>
    {webgl && <SceneBoundary key={renderer} onFailed={onRendererFailed}><Suspense fallback={<p role="status" style={noteStyle}>Loading the 3D view…</p>}>
      <CityScene key={vehicle.id} city={city} match={match} bus={bus} colors={COLORS} maxSpeed={maxSpeed} />
    </Suspense></SceneBoundary>}
    {page.graphics === "unavailable" && <div className="graphics-fallback" role="alertdialog" aria-labelledby="graphics-fallback-title" aria-describedby="graphics-fallback-text">
      <p id="graphics-fallback-title">The 3D view is not available</p>
      <p id="graphics-fallback-text">The 3D city needs WebGL, which this browser is not offering right now. Your match is paused and kept.</p>
      <button type="button" autoFocus onClick={onRetry}>Retry the 3D view</button>
    </div>}
  </div>;
}
