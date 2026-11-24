import { lineClear } from "./arena";
import type { CombatArenaLayout, CombatVehicleState, PickupState } from "./contracts";
import { createRng } from "./world";

export interface BotView {
  self: CombatVehicleState;
  vehicles: readonly CombatVehicleState[];
  pickups: readonly PickupState[];
  layout: CombatArenaLayout;
  tick: number;
}

export interface BotCommand {
  steer: number;
  throttle: number;
  brake: boolean;
  fire: boolean;
  missile: boolean;
  special: boolean;
}

export interface BotBrain {
  think(view: BotView): BotCommand;
}

/** Bots close in for this long before they open fire, so a new match starts with a beat to react. */
export const BOT_GRACE_TICKS = 240;
const GUN_RANGE = 30;
const GUN_ALIGNMENT = 0.14;
const LOW_HEALTH = 0.4;
const COVER_TICKS = 150;
const COVER_COOLDOWN_TICKS = 600;
const STUCK_TICKS = 30;
const REVERSE_TICKS = 40;

function wrap(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * A bot driver: chases the nearest threat (favouring the player), weaves while it fires, grabs
 * pickups when hurt or empty, ducks behind cover when badly hurt, and backs out when stuck.
 * All randomness comes from the seed it was built with, so a seeded match replays exactly.
 */
export function createBotBrain(seed: number): BotBrain {
  const rng = createRng(seed);
  let weaveUntil = 0;
  let weaveDir = 1;
  let coverUntil = 0;
  let coverReadyAt = 0;
  let stuck = 0;
  let reverseUntil = 0;
  let reverseSteer = 1;

  return {
    think(view): BotCommand {
      const { self, tick, layout } = view;
      const command: BotCommand = { steer: 0, throttle: 0, brake: false, fire: false, missile: false, special: false };
      if (!self.alive) return command;

      const enemies = view.vehicles.filter((v) => v.alive && v.playerId !== self.playerId);
      let target: CombatVehicleState | null = null;
      let best = Infinity;
      for (const enemy of enemies) {
        const score = Math.hypot(enemy.x - self.x, enemy.z - self.z) * (enemy.bot ? 1 : 0.45);
        if (score < best) {
          best = score;
          target = enemy;
        }
      }
      const distance = target ? Math.hypot(target.x - self.x, target.z - self.z) : Infinity;
      const healthFraction = self.health / self.maxHealth;
      const lowHealth = healthFraction < LOW_HEALTH;

      const readyPad = (kind: "health" | "ammo"): PickupState | undefined => view.pickups.find((p) => p.kind === kind && p.ready);
      let goal: { x: number; z: number } | null = null;
      let holdPosition = false;
      const healthPad = lowHealth ? readyPad("health") : undefined;
      const ammoPad = self.missiles === 0 && (!target || distance > 14) ? readyPad("ammo") : undefined;
      if (healthPad) goal = healthPad;
      else if (ammoPad) goal = ammoPad;
      else if (lowHealth && target && tick >= coverReadyAt) {
        if (coverUntil === 0) coverUntil = tick + COVER_TICKS;
        if (tick >= coverUntil) {
          coverReadyAt = tick + COVER_COOLDOWN_TICKS;
          coverUntil = 0;
          goal = target;
        } else {
          let nearest = layout.obstacles[0];
          let nearestDistance = Infinity;
          for (const box of layout.obstacles) {
            const d = Math.hypot(box.x - self.x, box.z - self.z);
            if (d < nearestDistance) {
              nearestDistance = d;
              nearest = box;
            }
          }
          const awayX = nearest.x - target.x;
          const awayZ = nearest.z - target.z;
          const awayLength = Math.hypot(awayX, awayZ) || 1;
          const reach = Math.max(nearest.halfX, nearest.halfZ) + 2.5;
          goal = { x: nearest.x + (awayX / awayLength) * reach, z: nearest.z + (awayZ / awayLength) * reach };
          holdPosition = Math.hypot(goal.x - self.x, goal.z - self.z) < 2;
        }
      } else if (target) {
        goal = target;
      }

      // Weave: alternate aiming straight (to shoot) with a sideways drift.
      if (tick >= weaveUntil) {
        weaveDir = rng() < 0.5 ? -1 : 1;
        weaveUntil = tick + 40 + Math.floor(rng() * 60);
      }
      const weaving = target !== null && goal === target && distance < 24 && (weaveUntil - tick) % 100 < 35;

      if (stuck >= STUCK_TICKS && tick >= reverseUntil) {
        reverseUntil = tick + REVERSE_TICKS;
        reverseSteer = rng() < 0.5 ? -1 : 1;
        stuck = 0;
      }
      if (tick < reverseUntil) {
        command.throttle = -1;
        command.steer = reverseSteer;
        return command;
      }

      let desired = self.heading;
      if (goal) {
        desired = Math.atan2(goal.x - self.x, goal.z - self.z);
        if (weaving) desired += weaveDir * 0.55;
        // Look ahead for cover or walls and swing wide when the way is blocked.
        const probe = (angle: number): boolean => {
          const px = self.x + Math.sin(angle) * 7;
          const pz = self.z + Math.cos(angle) * 7;
          if (Math.abs(px) > layout.halfExtent - 3 || Math.abs(pz) > layout.halfExtent - 3) return false;
          return lineClear(layout, self.x, self.z, px, pz) && layout.obstacles.every((o) => Math.abs(px - o.x) > o.halfX + 1.5 || Math.abs(pz - o.z) > o.halfZ + 1.5);
        };
        if (!probe(desired)) {
          const options = [0.8, -0.8, 1.6, -1.6];
          const swing = options.map((o) => desired + o).find((angle) => probe(angle));
          if (swing !== undefined) desired = swing;
        }
        const error = wrap(desired - self.heading);
        command.steer = clamp(-error * 2.5, -1, 1);
        const arrived = Math.hypot(goal.x - self.x, goal.z - self.z) < 3;
        command.throttle = holdPosition || (arrived && goal !== target) ? 0 : Math.abs(error) > 1.4 ? 0.3 : distance < 9 && goal === target ? 0.4 : 1;
        if (holdPosition) command.brake = true;
      }

      if (command.throttle > 0.2 && Math.abs(self.speed) < 1.5) stuck += 1;
      else stuck = Math.max(0, stuck - 2);

      if (target && tick >= BOT_GRACE_TICKS) {
        const aim = wrap(Math.atan2(target.x - self.x, target.z - self.z) - self.heading);
        const clear = lineClear(layout, self.x, self.z, target.x, target.z);
        command.fire = distance < GUN_RANGE && Math.abs(aim) < GUN_ALIGNMENT && clear;
        command.missile = self.missiles > 0 && self.lockId !== null && distance > 9 && rng() < 0.05;
        command.special =
          self.specialCooldown === 0 &&
          (self.special === "repair" ? healthFraction < 0.55 : self.special === "shockwave" ? distance < 9 : distance > 18 || lowHealth);
      }
      return command;
    },
  };
}
