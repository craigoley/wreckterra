/**
 * What finished matches earn: garage points that unlock vehicles, per-vehicle mastery with its
 * cosmetics, and passport badges. All of it is derived from the saved match results.
 *
 * INVARIANT sidegrades-only: nothing here changes a vehicle's numbers or any weapon. A locked
 * vehicle can always be test-driven, every place is always open, and there is no timer or streak.
 */
import { VEHICLE_KINDS, VEHICLE_SPECS, type VehicleSpec } from "../sim/arena";
import type { MatchReason, MatchStatus, VehicleKind } from "../sim/contracts";
import type { MatchRecord, Profile, ProgressStore } from "./profile";

export const STARTER: VehicleKind = "switchback";
export const FINISH_POINTS = 1;
export const WIN_BONUS_POINTS = 2;
/** Garage points that unlock each vehicle. */
export const UNLOCK_POINTS: Readonly<Record<VehicleKind, number>> = { switchback: 0, rivet: 3, voltage: 9 };
export const COSMETICS: readonly { mastery: number; name: string }[] = [
  { mastery: 3, name: "Road-worn decal" },
  { mastery: 12, name: "Gold trim" },
];
/** How far a vehicle's armour times top speed may sit from the starter's, as a fraction. */
export const SIDEGRADE_TOLERANCE = 0.15;

export function recordPoints(record: MatchRecord): number {
  return FINISH_POINTS + (record.outcome === "won" ? WIN_BONUS_POINTS : 0);
}

const total = (records: readonly MatchRecord[]): number => records.reduce((sum, r) => sum + recordPoints(r), 0);

export function garagePoints(profile: Profile): number {
  return total(profile.matches);
}

/** Points earned in a vehicle while it was unlocked. */
export function vehicleMastery(profile: Profile, vehicle: VehicleKind): number {
  return total(profile.matches.filter((r) => r.vehicle === vehicle && !r.testDrive));
}

export type VehicleAccess = "owned" | "test-drive";

export function vehicleAccess(profile: Profile, vehicle: VehicleKind): VehicleAccess {
  return garagePoints(profile) >= UNLOCK_POINTS[vehicle] ? "owned" : "test-drive";
}

const STATS = ["maxHealth", "maxSpeed", "acceleration", "turnRate"] as const;

/** Throw unless every vehicle is a trade: none beats another outright, and all stay near the starter's budget. */
export function assertSidegrades(specs: Readonly<Record<VehicleKind, VehicleSpec>>): void {
  const budget = specs[STARTER].maxHealth * specs[STARTER].maxSpeed;
  for (const a of VEHICLE_KINDS) {
    if (Math.abs(specs[a].maxHealth * specs[a].maxSpeed / budget - 1) > SIDEGRADE_TOLERANCE) {
      throw new Error(`${a} is outside the budget for a sidegrade`);
    }
    for (const b of VEHICLE_KINDS) {
      if (a !== b && STATS.every((s) => specs[a][s] >= specs[b][s]) && STATS.some((s) => specs[a][s] > specs[b][s])) {
        throw new Error(`${a} is at least as good as ${b} in every way, so it is not a sidegrade`);
      }
    }
  }
}

export interface GarageRow {
  id: VehicleKind;
  access: VehicleAccess;
  /** Garage points still needed to unlock it; 0 once owned. */
  pointsToUnlock: number;
  mastery: number;
  cosmetics: string[];
}

export function garageView(profile: Profile, specs: Readonly<Record<VehicleKind, VehicleSpec>> = VEHICLE_SPECS): GarageRow[] {
  assertSidegrades(specs);
  const points = garagePoints(profile);
  return VEHICLE_KINDS.map((id) => {
    const mastery = vehicleMastery(profile, id);
    return {
      id,
      access: vehicleAccess(profile, id),
      pointsToUnlock: Math.max(0, UNLOCK_POINTS[id] - points),
      mastery,
      cosmetics: COSMETICS.filter((c) => mastery >= c.mastery).map((c) => c.name),
    };
  });
}

/** A stamp for each curated place won, and one for lasting a whole match clock. */
export function passportBadges(profile: Profile): string[] {
  const badges = new Set<string>();
  for (const r of profile.matches) {
    if (r.outcome === "won" && r.passport !== null) badges.add(`World Tour: ${r.passport}`);
    if (r.reason === "time-limit") badges.add("Survivor: lasted the full clock");
  }
  return [...badges];
}

/** An id for one play of a match. The simulation seed repeats between plays, so it cannot identify one. */
export function newMatchId(): string {
  // randomUUID is missing on an insecure origin, such as a phone testing over plain http.
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export interface MatchResult {
  matchId: string;
  vehicle: VehicleKind;
  status: MatchStatus;
  reason: MatchReason | null;
  ticks: number;
  passport: string | null;
}

export interface Award {
  /** False when this match had already been rewarded. */
  awarded: boolean;
  /** The result as it was first rewarded. */
  record: MatchRecord;
  points: number;
}

/** Reward a finished match, once per match id. Returns null while the match is unfinished. */
export function awardMatch(store: ProgressStore, result: MatchResult): Award | null {
  if (result.status === "running" || result.reason === null) return null;
  // Reconcile first, so a reward another tab already saved is seen.
  const { profile } = store.save();
  const earlier = profile.matches.find((r) => r.id === result.matchId);
  if (earlier) return { awarded: false, record: earlier, points: recordPoints(earlier) };
  const record: MatchRecord = {
    id: result.matchId,
    vehicle: result.vehicle,
    outcome: result.status,
    reason: result.reason,
    ticks: result.ticks,
    passport: result.passport,
    testDrive: vehicleAccess(profile, result.vehicle) === "test-drive",
    verified: false,
  };
  store.add(record);
  return { awarded: true, record, points: recordPoints(record) };
}
