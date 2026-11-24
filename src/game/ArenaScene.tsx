import { memo, useMemo } from "react";
import { PLAYER_ID } from "../sim/combat";
import type { CombatArenaLayout, CombatSnapshot, CombatVehicleState, SimEvent } from "../sim/contracts";
import { VEHICLES } from "./VehicleScene";

/** A short-lived visual: a tracer line or a burst of sparks, kept for a few ticks after the event. */
export interface Fx {
  id: number;
  kind: "shot" | "spark" | "blast";
  tick: number;
  x: number;
  z: number;
  toX?: number;
  toZ?: number;
}

const FX_LIFE: Record<Fx["kind"], number> = { shot: 5, spark: 14, blast: 24 };
let nextFxId = 1;

/** Turn simulation events into visuals. Only shots and hits draw anything. */
export function fxFromEvents(events: readonly SimEvent[]): Fx[] {
  const out: Fx[] = [];
  for (const event of events) {
    if (event.kind === "shot") out.push({ id: nextFxId++, kind: "shot", tick: event.tick, x: event.x, z: event.z, toX: event.toX, toZ: event.toZ });
    else if (event.kind === "hit") out.push({ id: nextFxId++, kind: event.weapon === "gun" ? "spark" : "blast", tick: event.tick, x: event.x, z: event.z });
  }
  return out;
}

export function liveFx(fx: readonly Fx[], tick: number): Fx[] {
  return fx.filter((f) => tick - f.tick < FX_LIFE[f.kind]);
}

const COLORS: Record<string, string> = Object.fromEntries(VEHICLES.map((v) => [v.id, v.color]));
const SIZE: Record<string, number> = { switchback: 1, rivet: 1.2, voltage: 0.9 };

const Floor = memo(function Floor({ layout }: { layout: CombatArenaLayout }) {
  const half = layout.halfExtent;
  return (
    <g>
      <defs>
        <pattern id="ramp-stripes" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2" height="2" fill="#3d3523" />
          <rect width="1" height="2" fill="#7a6a35" />
        </pattern>
      </defs>
      <rect x={-half} y={-half} width={half * 2} height={half * 2} className="arena-floor" />
      <rect x={-half} y={-half} width={half * 2} height={half * 2} className="arena-wall" fill="none" />
      {layout.ramps.map((r, i) => <rect key={`r${i}`} x={r.x - r.halfX} y={r.z - r.halfZ} width={r.halfX * 2} height={r.halfZ * 2} fill="url(#ramp-stripes)" stroke="#b79b4a" strokeWidth="0.2" />)}
      {layout.obstacles.map((o, i) => <rect key={`o${i}`} x={o.x - o.halfX} y={o.z - o.halfZ} width={o.halfX * 2} height={o.halfZ * 2} className="arena-block" />)}
    </g>
  );
});

function Car({ car, tick, label }: { car: CombatVehicleState; tick: number; label: string }) {
  const size = SIZE[car.kind] ?? 1;
  const fraction = car.health / car.maxHealth;
  const flashing = car.alive && tick - car.lastHitTick < 6;
  const lift = car.airborne > 0 ? 1.25 : 1;
  const pose = `translate(${car.x.toFixed(2)} ${car.z.toFixed(2)}) rotate(${((-car.heading * 180) / Math.PI).toFixed(1)})`;
  if (!car.alive) {
    const age = car.wreckedTick === null ? 99 : tick - car.wreckedTick;
    return (
      <g transform={pose} aria-hidden="true">
        <polygon points="0,2 -1.2,-1.6 1.2,-1.6" fill="#1b1d1b" stroke="#000" strokeWidth="0.25" transform={`scale(${size})`} />
        <path d="M-1 -1 L1 1 M1 -1 L-1 1" stroke="#5c3a22" strokeWidth="0.3" />
        {age < 45 && <circle r={1 + age * 0.22} fill="#ff9d3c" opacity={Math.max(0, 0.9 - age / 45)} />}
        {age < 45 && <circle r={0.5 + age * 0.12} fill="#fff1b0" opacity={Math.max(0, 1 - age / 25)} />}
      </g>
    );
  }
  return (
    <g>
      <g transform={pose}>
        <g transform={`scale(${size * lift})`}>
          <polygon points="0,2 -1.2,-1.6 1.2,-1.6" fill={flashing ? "#ffffff" : COLORS[car.kind]} stroke={car.bot ? "#111a16" : "#ffffff"} strokeWidth={car.bot ? 0.3 : 0.4} />
        </g>
        {car.boost > 0 && <polygon points="-0.7,-1.7 0.7,-1.7 0,-4" fill="#7fd4ff" opacity="0.8" />}
      </g>
      {fraction < 0.3 && [0, 1, 2].map((i) => {
        const phase = ((tick + i * 7) % 24) / 24;
        return <circle key={i} cx={car.x + (i - 1) * 0.6} cy={car.z - phase * 3} r={0.6 + phase * 1.2} fill="#444" opacity={0.7 - phase * 0.6} />;
      })}
      <text x={car.x} y={car.z - 2.6} className="car-label" textAnchor="middle">{label}</text>
      {car.bot && (
        <g>
          <rect x={car.x - 1.5} y={car.z - 2.2} width="3" height="0.4" fill="#2a1c1a" />
          <rect x={car.x - 1.5} y={car.z - 2.2} width={3 * fraction} height="0.4" fill={fraction < 0.3 ? "#e8553f" : "#6fd48a"} />
        </g>
      )}
    </g>
  );
}

/** Top-down arena: the walled lot, pads, ramps, cars with damage feedback, missiles, tracers and lock reticle. */
export function ArenaScene({ snapshot, layout, fx, vehicleName }: { snapshot: CombatSnapshot; layout: CombatArenaLayout; fx: readonly Fx[]; vehicleName: string }) {
  const half = layout.halfExtent;
  const tick = snapshot.tick;
  const player = snapshot.vehicles.find((v) => v.playerId === PLAYER_ID);
  const locked = player?.lockId ? snapshot.vehicles.find((v) => v.playerId === player.lockId) : undefined;
  const botNumber = useMemo(() => (id: string) => id.replace("bot-", "B"), []);
  return (
    <svg viewBox={`${-half - 1} ${-half - 1} ${half * 2 + 2} ${half * 2 + 2}`} role="img" aria-label={`Top-down combat arena. You are driving ${vehicleName}.`}>
      <Floor layout={layout} />
      {snapshot.pickups.map((p) => (
        <g key={p.id} opacity={p.ready ? 1 : 0.25}>
          <circle cx={p.x} cy={p.z} r="2.5" fill="none" stroke={p.kind === "health" ? "#6fd48a" : "#f0b34a"} strokeWidth="0.3" strokeDasharray="1 0.6" />
          <text x={p.x} y={p.z + 0.9} textAnchor="middle" className="pad-glyph" fill={p.kind === "health" ? "#6fd48a" : "#f0b34a"}>{p.kind === "health" ? "+" : "▲"}</text>
        </g>
      ))}
      {snapshot.vehicles.map((car) => <Car key={car.playerId} car={car} tick={tick} label={car.bot ? botNumber(car.playerId) : "YOU"} />)}
      {snapshot.missiles.map((m) => (
        <g key={m.id} transform={`translate(${m.x.toFixed(2)} ${m.z.toFixed(2)}) rotate(${((-m.heading * 180) / Math.PI).toFixed(1)})`}>
          <polygon points="0,0.9 -0.35,-0.7 0.35,-0.7" fill="#fff" />
          <polygon points="-0.25,-0.7 0.25,-0.7 0,-2.6" fill="#ff7a2f" opacity="0.8" />
        </g>
      ))}
      {fx.map((f) => {
        const age = tick - f.tick;
        if (f.kind === "shot") return <line key={f.id} x1={f.x} y1={f.z} x2={f.toX} y2={f.toZ} stroke="#ffe48a" strokeWidth="0.25" opacity={Math.max(0, 1 - age / 5)} />;
        const life = FX_LIFE[f.kind];
        const radius = f.kind === "blast" ? 1 + age * 0.22 : 0.4 + age * 0.12;
        return <circle key={f.id} cx={f.x} cy={f.z} r={radius} fill={f.kind === "blast" ? "#ff8a3c" : "#ffd36b"} opacity={Math.max(0, 0.9 - age / life)} />;
      })}
      {player?.alive && locked?.alive && (
        <g className="lock-reticle">
          <circle cx={locked.x} cy={locked.z} r="2.8" fill="none" stroke="#ff4a3a" strokeWidth="0.35" strokeDasharray="1.2 0.8" />
          <line x1={player.x} y1={player.z} x2={locked.x} y2={locked.z} stroke="#ff4a3a" strokeWidth="0.12" opacity="0.6" />
        </g>
      )}
    </svg>
  );
}
