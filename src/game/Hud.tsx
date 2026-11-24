import type { CombatSnapshot, SpecialKind } from "../sim/contracts";
import { PLAYER_ID } from "../sim/combat";
import { TICK_RATE } from "../sim/contracts";

const SPECIAL_NAMES: Record<SpecialKind, string> = { repair: "Repair kit", shockwave: "Shockwave", afterburner: "Afterburner" };

function clock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
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
