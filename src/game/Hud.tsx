import type { CombatSnapshot, SpecialKind } from "../sim/contracts";
import { PLAYER_ID } from "../sim/combat";
import { TICK_RATE } from "../sim/contracts";

const SPECIAL_NAMES: Record<SpecialKind, string> = { repair: "Repair kit", shockwave: "Shockwave", afterburner: "Afterburner" };

function clock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const RADAR_METRES = 160;
const RADAR_RADIUS = 46;

/** Bots and pickups around you, in the direction you are facing, so a fight in the streets is never lost behind a block. */
function Radar({ snapshot }: { snapshot: CombatSnapshot }) {
  const me = snapshot.vehicles.find((v) => v.playerId === PLAYER_ID);
  if (!me) return null;
  const fx = Math.sin(me.heading);
  const fz = Math.cos(me.heading);
  const place = (x: number, z: number): { x: number; y: number; far: boolean } => {
    const dx = x - me.x;
    const dz = z - me.z;
    // Right of travel is (-fz, fx); ahead is up the screen.
    let px = ((dx * -fz + dz * fx) / RADAR_METRES) * RADAR_RADIUS;
    let py = -((dx * fx + dz * fz) / RADAR_METRES) * RADAR_RADIUS;
    const length = Math.hypot(px, py);
    const far = length > RADAR_RADIUS;
    if (far) { px = (px / length) * RADAR_RADIUS; py = (py / length) * RADAR_RADIUS; }
    return { x: px, y: py, far };
  };
  return (
    <svg className="radar" viewBox="-50 -50 100 100" role="img" aria-label="Radar" style={{ width: 84, height: 84, flex: "none" }}>
      <circle r="49" fill="#0d1510" stroke="#324534" strokeWidth="1.5" />
      <circle r="24" fill="none" stroke="#243428" strokeWidth="0.8" />
      {snapshot.pickups.filter((p) => p.ready).map((p) => {
        const at = place(p.x, p.z);
        return <rect key={p.id} x={at.x - 2} y={at.y - 2} width="4" height="4" fill={p.kind === "health" ? "#53e08a" : "#ffb340"} opacity={at.far ? 0.4 : 0.9} />;
      })}
      {snapshot.vehicles.filter((v) => v.bot && v.alive).map((v) => {
        const at = place(v.x, v.z);
        return <circle key={v.playerId} cx={at.x} cy={at.y} r={at.far ? 3 : 4} fill="#e8553f" stroke={me.lockId === v.playerId ? "#ffffff" : "none"} strokeWidth="1.5" />;
      })}
      <polygon points="0,-6 4,5 0,3 -4,5" fill="#35b6ff" />
    </svg>
  );
}

/** Always-visible health, ammo, special, lock and match state, with a one-tap restart. */
export function Hud({ snapshot, onRestart }: { snapshot: CombatSnapshot; onRestart: () => void }) {
  const player = snapshot.vehicles.find((v) => v.playerId === PLAYER_ID);
  if (!player) return null;
  const { match } = snapshot;
  const elapsed = Math.min(snapshot.tick, match.endedTick ?? snapshot.tick);
  const fraction = player.health / player.maxHealth;
  const bots = snapshot.vehicles.filter((v) => v.bot).length;
  const ready = player.specialCooldown === 0;
  return (
    <div className={`hud${fraction < 0.3 && player.alive ? " hud-critical" : ""}`}>
      <div className="hud-row">
        <div className="hud-health">
          <span className="hud-label">Health</span>
          <div className="meter" role="meter" aria-label="Your health" aria-valuemin={0} aria-valuemax={player.maxHealth} aria-valuenow={Math.round(player.health)}>
            <div className="meter-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
          <span className="hud-value">{Math.round(player.health)} / {player.maxHealth}</span>
        </div>
        <div className="hud-clock" aria-label="Time left">{clock((match.timeLimitTicks - elapsed) / TICK_RATE)}</div>
        <button type="button" className="restart" onClick={onRestart}>Restart</button>
      </div>
      <div className="hud-row hud-stats">
        <span>Missiles {player.missiles}/{player.maxMissiles}</span>
        <span className={player.lockId ? "lock lock-on" : "lock"} aria-live="polite">{player.lockId ? "LOCKED" : "No lock"}</span>
        <span>{SPECIAL_NAMES[player.special]}: {ready ? "ready" : `${Math.ceil(player.specialCooldown / TICK_RATE)}s`}</span>
        <span>Bots left {match.botsAlive}/{bots}</span>
        <span>{Math.round(Math.abs(player.speed) * 3.6)} km/h</span>
        <Radar snapshot={snapshot} />
      </div>
      {match.status !== "running" && (
        <p className={`banner banner-${match.status}`} role="status">
          {match.status === "won"
            ? match.reason === "time-limit" ? "Victory — you held out the clock." : "Victory — last car running!"
            : match.reason === "time-limit" ? "Defeat — time ran out." : "Wrecked!"}
          {" "}Tap Restart to go again.
        </p>
      )}
    </div>
  );
}
