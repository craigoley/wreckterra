/**
 * Durable local progress: an account-free, versioned save on this device, with export and import.
 * Nothing here knows about React or the renderer, so losing the graphics context loses no progress.
 *
 * INVARIANT never-pretend-saved: `saved` is true only after the device copy has been read back and
 * holds every result in memory. Damaged, newer or vanished saves are never overwritten silently;
 * results are held in memory until the player recovers.
 *
 * INVARIANT one-result-once: results are keyed by match id and only ever united, so a replay, a
 * second tab or a restored backup cannot add the same match twice.
 */
import { VEHICLE_KINDS } from "../sim/arena";
import type { MatchReason, VehicleKind } from "../sim/contracts";

export const PROFILE_KEY = "wreckterra.profile";
/** Where a damaged save is copied before a new one replaces it. */
export const DAMAGED_KEY = "wreckterra.profile.damaged";
export const PROFILE_FORMAT = "wreckterra-profile";
export const PROFILE_VERSION = 1;

/** One finished match. Rewards are derived from these facts, never stored as running totals. */
export interface MatchRecord {
  id: string;
  vehicle: VehicleKind;
  outcome: "won" | "lost";
  reason: MatchReason;
  ticks: number;
  /** The curated place the match was fought in, or null anywhere else. */
  passport: string | null;
  /** The vehicle was still locked when this match was played. */
  testDrive: boolean;
  /** Played offline on this device; no server has checked it. */
  verified: false;
}

export interface Profile { matches: readonly MatchRecord[] }

export const EMPTY_PROFILE: Profile = { matches: [] };

/** Every result in `base`, then any in `extra` with an id not seen yet. Returns `base` itself when nothing is new. */
export function mergeProfiles(base: Profile, extra: Profile): Profile {
  const seen = new Set(base.matches.map((m) => m.id));
  const added = extra.matches.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  return added.length === 0 ? base : { matches: [...base.matches, ...added] };
}

/* ------------------------------------------------------------------ the format */

/** Turns data of version N into version N + 1. */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/** Keyed by the version migrated from. Version 1 is the first format, so there is nothing to migrate yet. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

export type Decoded =
  | { ok: true; profile: Profile; migrated: boolean }
  | { ok: false; kind: "corrupt" | "newer"; detail: string };

export function encodeProfile(profile: Profile): string {
  return JSON.stringify({ format: PROFILE_FORMAT, version: PROFILE_VERSION, matches: profile.matches });
}

const REASONS: readonly MatchReason[] = ["last-car-running", "wrecked", "time-limit"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): MatchRecord | null {
  if (!isObject(value)) return null;
  const { id, vehicle, outcome, reason, ticks, passport, testDrive } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (!VEHICLE_KINDS.includes(vehicle as VehicleKind) || (outcome !== "won" && outcome !== "lost")) return null;
  if (!REASONS.includes(reason as MatchReason) || typeof ticks !== "number" || !Number.isInteger(ticks) || ticks < 0) return null;
  if ((passport !== null && typeof passport !== "string") || typeof testDrive !== "boolean") return null;
  // A file cannot declare itself verified: only a server could, and there is none yet.
  return { id, vehicle: vehicle as VehicleKind, outcome, reason: reason as MatchReason, ticks, passport, testDrive, verified: false };
}

const corrupt = (detail: string): Decoded => ({ ok: false, kind: "corrupt", detail });

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read a save or a backup, migrating an older format forward. Any unreadable result makes the whole file corrupt. */
export function decodeProfile(text: string, migrations: Readonly<Record<number, Migration>> = MIGRATIONS): Decoded {
  try {
    let data: unknown = JSON.parse(text);
    if (!isObject(data) || data.format !== PROFILE_FORMAT) return corrupt("it is not a Wreckterra save");
    let version = data.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return corrupt("it has no version");
    if (version > PROFILE_VERSION) return { ok: false, kind: "newer", detail: `it is version ${version}; this game reads up to ${PROFILE_VERSION}` };
    const migrated = version < PROFILE_VERSION;
    for (; version < PROFILE_VERSION; version += 1) {
      const step: Migration | undefined = migrations[version];
      if (!step) return corrupt(`there is no migration from version ${version}`);
      data = step(data as Record<string, unknown>);
    }
    const list = isObject(data) ? data.matches : undefined;
    if (!Array.isArray(list)) return corrupt("it has no match list");
    const matches: MatchRecord[] = [];
    for (const item of list) {
      const record = readRecord(item);
      if (!record) return corrupt("one of its match results is unreadable");
      matches.push(record);
    }
    return { ok: true, profile: mergeProfiles(EMPTY_PROFILE, { matches }), migrated };
  } catch (error) {
    return corrupt(describeError(error));
  }
}

/* ------------------------------------------------------------------ the store */

export type ProfileStorage = Pick<Storage, "getItem" | "setItem">;

export type ProblemKind = "denied" | "write-failed" | "corrupt" | "newer" | "evicted";

export interface Problem { kind: ProblemKind; detail: string }

export interface ProgressState {
  /** Everything earned, including results the device has not accepted yet. */
  profile: Profile;
  /** The device copy holds everything in `profile`. */
  saved: boolean;
  problem: Problem | null;
}

export type ImportResult =
  | { ok: true; added: number; state: ProgressState }
  | { ok: false; reason: string };

export interface ProgressStore {
  state(): ProgressState;
  subscribe(listener: () => void): () => void;
  /** Reconcile with the device: take in what it holds and write what it lacks. Safe to call at any time. */
  save(): ProgressState;
  /** Keep a result and try to save it. A result already held is ignored. */
  add(record: MatchRecord): ProgressState;
  /** The player's explicit go-ahead to replace a damaged save (after copying it) or to rewrite a vanished one. */
  recover(): ProgressState;
  exportBackup(): string;
  importBackup(text: string): ImportResult;
}

function browserStorage(): ProfileStorage | null {
  // Reading the property itself throws when site data is blocked; the store reports that.
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function createProgressStore(open: () => ProfileStorage | null = browserStorage): ProgressStore {
  let memory = EMPTY_PROFILE;
  /** This page has seen a save on the device, so its absence now means it was removed. */
  let seen = false;
  let current: ProgressState = { profile: memory, saved: false, problem: null };
  const listeners = new Set<() => void>();

  function publish(problem: Problem | null): ProgressState {
    const saved = problem === null;
    if (current.profile !== memory || current.saved !== saved || current.problem?.kind !== problem?.kind || current.problem?.detail !== problem?.detail) {
      current = { profile: memory, saved, problem };
      for (const listener of listeners) listener();
    }
    return current;
  }

  function device(): ProfileStorage {
    const storage = open();
    if (!storage) throw new Error("this browser offers no storage");
    return storage;
  }

  /** Write and read back: a browser that drops the write quietly has not saved anything. */
  function write(storage: ProfileStorage, key: string, text: string): void {
    storage.setItem(key, text);
    if (storage.getItem(key) !== text) throw new Error("the browser did not keep what was written");
  }

  function save(): ProgressState {
    let storage: ProfileStorage;
    let text: string | null;
    try {
      storage = device();
      text = storage.getItem(PROFILE_KEY);
    } catch (error) {
      return publish({ kind: "denied", detail: describeError(error) });
    }
    let onDevice = EMPTY_PROFILE;
    let outdated = false;
    if (text === null) {
      if (seen) return publish({ kind: "evicted", detail: "the saved progress is no longer on this device" });
    } else {
      const decoded = decodeProfile(text);
      if (!decoded.ok) return publish({ kind: decoded.kind, detail: decoded.detail });
      onDevice = decoded.profile;
      outdated = decoded.migrated;
      seen = true;
    }
    memory = mergeProfiles(memory, onDevice);
    if (outdated || memory.matches.length > onDevice.matches.length) {
      try { write(storage, PROFILE_KEY, encodeProfile(memory)); }
      catch (error) { return publish({ kind: "write-failed", detail: describeError(error) }); }
      seen = true;
    }
    return publish(null);
  }

  function recover(): ProgressState {
    if (current.problem?.kind === "evicted") seen = false;
    if (current.problem?.kind === "corrupt") {
      try {
        const storage = device();
        const text = storage.getItem(PROFILE_KEY);
        const decoded = text === null ? null : decodeProfile(text);
        if (text !== null && decoded && !decoded.ok && decoded.kind === "corrupt") {
          // The copy comes first: if it cannot be kept, the damaged save stays where it is.
          write(storage, DAMAGED_KEY, text);
          write(storage, PROFILE_KEY, encodeProfile(memory));
        }
        if (text === null) seen = false;
      } catch (error) {
        return publish({ kind: "corrupt", detail: `it could not be replaced (${describeError(error)})` });
      }
    }
    return save();
  }

  save();

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    save,
    add(record) {
      memory = mergeProfiles(memory, { matches: [record] });
      return save();
    },
    recover,
    exportBackup: () => encodeProfile(memory),
    importBackup(text) {
      const decoded = decodeProfile(text);
      if (!decoded.ok) {
        return { ok: false, reason: decoded.kind === "newer" ? `That backup is from a newer version of the game (${decoded.detail}).` : `That is not a readable backup: ${decoded.detail}.` };
      }
      // Look at the device first, so a damaged or vanished save is known before anything is merged.
      save();
      const before = memory.matches.length;
      memory = mergeProfiles(memory, decoded.profile);
      const added = memory.matches.length - before;
      // Restoring a backup is itself the player's go-ahead to recover.
      const state = recover();
      return { ok: true, added, state };
    },
  };
}

/**
 * Save whenever the page may be about to be interrupted: leaving or hiding it, coming back to it,
 * another tab writing, or the graphics context being lost. Returns a function that detaches.
 */
export function saveOnInterruption(store: ProgressStore, win: Window = window): () => void {
  const flush = () => { store.save(); };
  const doc = win.document;
  win.addEventListener("pagehide", flush);
  win.addEventListener("storage", flush);
  doc.addEventListener("visibilitychange", flush);
  // A canvas's context-loss event does not bubble, so listen on the way down to it.
  doc.addEventListener("webglcontextlost", flush, true);
  return () => {
    win.removeEventListener("pagehide", flush);
    win.removeEventListener("storage", flush);
    doc.removeEventListener("visibilitychange", flush);
    doc.removeEventListener("webglcontextlost", flush, true);
  };
}
