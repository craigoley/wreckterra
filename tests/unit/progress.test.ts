import { readFileSync } from "node:fs";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { Garage } from "../../src/game/Garage";
import { parseCity } from "../../src/maps/midtown";
import type { LiveCityOutcome } from "../../src/maps/tile-city";
import {
  createProgressStore, DAMAGED_KEY, decodeProfile, encodeProfile, PROFILE_KEY, PROFILE_VERSION, type MatchRecord, type ProfileStorage,
} from "../../src/progress/profile";
import {
  assertSidegrades, awardMatch, garagePoints, garageView, passportBadges, UNLOCK_POINTS, vehicleAccess, vehicleMastery, type MatchResult,
} from "../../src/progress/rewards";
import { VEHICLE_KINDS, VEHICLE_SPECS, type VehicleSpec } from "../../src/sim/arena";
import * as combat from "../../src/sim/combat";
import type { VehicleKind } from "../../src/sim/contracts";
import { NOMINATIM_ATTRIBUTION, type PlaceSearch } from "../../src/ui/place-search";
import type { MapFactory } from "../../src/ui/StartScreen";

/** Lets a test end the app's running match; null leaves the real simulation alone. */
const ending = vi.hoisted(() => ({ status: null as "won" | "lost" | null }));

vi.mock("../../src/sim/combat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sim/combat")>();
  return {
    ...actual,
    createCityMatch: vi.fn((...args: Parameters<typeof actual.createCityMatch>) => {
      const real = actual.createCityMatch(...args);
      return {
        ...real,
        snapshot: () => {
          const now = real.snapshot();
          return ending.status ? { ...now, match: { ...now.match, status: ending.status, reason: "last-car-running" as const, endedTick: now.tick } } : now;
        },
        restart: () => { ending.status = null; real.restart(); },
      };
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  ending.status = null;
  vi.mocked(combat.createCityMatch).mockClear();
});

/** An in-memory device store whose failures a test can switch on. */
function device(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const faults = { open: false, read: false, write: false, drop: false, refuse: null as string | null };
  const storage: ProfileStorage = {
    getItem: (key) => { if (faults.read) throw new Error("reads are blocked"); return data.get(key) ?? null; },
    setItem: (key, value) => {
      if (faults.write || faults.refuse === key) throw new Error("quota exceeded");
      if (!faults.drop) data.set(key, value);
    },
  };
  const open = () => { if (faults.open) throw new Error("access denied"); return storage; };
  return { data, faults, open };
}

const result = (matchId: string, over: Partial<MatchResult> = {}): MatchResult => (
  { matchId, vehicle: "switchback", status: "won", reason: "last-car-running", ticks: 900, passport: null, ...over }
);
const record = (id: string, over: Partial<MatchRecord> = {}): MatchRecord => (
  { id, vehicle: "switchback", outcome: "won", reason: "last-car-running", ticks: 900, passport: null, testDrive: false, verified: false, ...over }
);
const savedIds = (text: string | null | undefined): string[] => {
  const decoded = decodeProfile(text ?? "");
  if (!decoded.ok) throw new Error(`not a readable save: ${decoded.detail}`);
  return decoded.profile.matches.map((m) => m.id);
};

const city = parseCity(JSON.parse(readFileSync("public/maps/midtown/city.json", "utf8")));
const search: PlaceSearch = { attribution: NOMINATIM_ATTRIBUTION, search: async () => ({ ok: true as const, places: [] }) };
const loaded: LiveCityOutcome = { ok: true, city, from: "cache", stats: null, notes: [] };

async function playApp() {
  let tap: (point: { lat: number; lon: number }) => void = () => undefined;
  const map: MapFactory = async (_element, options) => { tap = options.onPick; return { show: () => undefined, destroy: () => undefined }; };
  const load = vi.fn(async (_point: { lat: number; lon: number }) => loaded);
  render(createElement(App, { loadCity: load, search, createMap: map }));
  await act(async () => undefined);
  return { load, tap: (point: { lat: number; lon: number }) => act(() => { tap(point); }) };
}

async function startMatch() {
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  await screen.findByLabelText("Combat city");
}

async function endMatch(status: "won" | "lost" = "won") {
  ending.status = status;
  return screen.findByRole("dialog", { name: "Match results" });
}

const nextFrames = () => act(() => new Promise<void>((done) => { setTimeout(done, 150); }));

describe("WRECK-T5: mastery and interruption-safe progress", () => {
  it("WRECK-T5: replaying a match result rewards mastery only once", () => {
    const disk = device();
    const first = createProgressStore(disk.open);
    const otherTab = createProgressStore(disk.open);

    expect(awardMatch(first, result("m1"))).toMatchObject({ awarded: true, points: 3 });
    expect(awardMatch(first, result("m1"))).toMatchObject({ awarded: false, points: 3 });
    // A replay that claims a different outcome does not rewrite or top up the first one.
    expect(awardMatch(first, result("m1", { status: "lost", reason: "wrecked" }))).toMatchObject({ awarded: false, points: 3 });
    expect(vehicleMastery(first.state().profile, "switchback")).toBe(3);

    // Another tab that was open all along, and a reload, both see it was already paid.
    expect(awardMatch(otherTab, result("m1"))!.awarded).toBe(false);
    const reloaded = createProgressStore(disk.open);
    expect(awardMatch(reloaded, result("m1"))!.awarded).toBe(false);

    // Restoring a backup over the same progress adds nothing, even when the file repeats a result.
    expect(reloaded.importBackup(reloaded.exportBackup())).toMatchObject({ ok: true, added: 0 });
    const doubled = JSON.stringify({ format: "wreckterra-profile", version: PROFILE_VERSION, matches: [record("m1"), record("m2"), record("m2")] });
    expect(reloaded.importBackup(doubled)).toMatchObject({ ok: true, added: 1 });
    expect(savedIds(disk.data.get(PROFILE_KEY))).toEqual(["m1", "m2"]);
    expect(vehicleMastery(reloaded.state().profile, "switchback")).toBe(6);
    expect(garagePoints(reloaded.state().profile)).toBe(6);

    // An unfinished match is not a result.
    expect(awardMatch(reloaded, result("m3", { status: "running", reason: null }))).toBeNull();
    expect(savedIds(disk.data.get(PROFILE_KEY))).toEqual(["m1", "m2"]);
    // Every offline result stays unverified, whatever a backup file claims.
    const boast = encodeProfile({ matches: [record("m9")] }).replace('"verified":false', '"verified":true');
    expect(boast).toContain('"verified":true');
    reloaded.importBackup(boast);
    expect(reloaded.state().profile.matches.map((m) => m.verified)).toEqual([false, false, false]);
  });

  it("WRECK-T5: corrupt or denied local storage recovers without pretending progress saved", () => {
    // Damaged data: reported, left exactly as it was, and replaced only on request after a copy is kept.
    const damaged = "{not json";
    const disk = device({ [PROFILE_KEY]: damaged });
    const store = createProgressStore(disk.open);
    expect(store.state()).toMatchObject({ saved: false, problem: { kind: "corrupt" } });
    awardMatch(store, result("m1"));
    expect(store.save()).toMatchObject({ saved: false, problem: { kind: "corrupt" } });
    expect(disk.data.get(PROFILE_KEY)).toBe(damaged);
    disk.faults.refuse = DAMAGED_KEY;
    expect(store.recover()).toMatchObject({ saved: false, problem: { kind: "corrupt" } });
    expect(disk.data.get(PROFILE_KEY)).toBe(damaged);
    disk.faults.refuse = null;
    expect(store.recover()).toMatchObject({ saved: true, problem: null });
    expect(disk.data.get(DAMAGED_KEY)).toBe(damaged);
    expect(savedIds(disk.data.get(PROFILE_KEY))).toEqual(["m1"]);

    // Well-formed JSON with a broken record is damage too, never silently trimmed.
    const broken = JSON.stringify({ format: "wreckterra-profile", version: PROFILE_VERSION, matches: [record("ok"), { id: "bad", vehicle: "tank" }] });
    expect(createProgressStore(device({ [PROFILE_KEY]: broken }).open).state()).toMatchObject({ saved: false, problem: { kind: "corrupt" } });

    // A save from a newer build is never overwritten, not even by recovery.
    const newer = JSON.stringify({ format: "wreckterra-profile", version: PROFILE_VERSION + 1, matches: [] });
    const future = device({ [PROFILE_KEY]: newer });
    const old = createProgressStore(future.open);
    awardMatch(old, result("m1"));
    expect(old.recover()).toMatchObject({ saved: false, problem: { kind: "newer" } });
    old.importBackup(encodeProfile({ matches: [record("m2")] }));
    expect(future.data.get(PROFILE_KEY)).toBe(newer);

    // The damaged save was replaced by a newer build's (another tab) before the player pressed recover.
    const raced = device({ [PROFILE_KEY]: damaged });
    const slow = createProgressStore(raced.open);
    raced.data.set(PROFILE_KEY, newer);
    expect(slow.recover()).toMatchObject({ saved: false, problem: { kind: "newer" } });
    expect(raced.data.get(PROFILE_KEY)).toBe(newer);

    // Storage denied outright: progress is held for this page, and saved once access returns.
    const locked = device({ [PROFILE_KEY]: encodeProfile({ matches: [record("earlier")] }) });
    locked.faults.open = true;
    const denied = createProgressStore(locked.open);
    expect(denied.state()).toMatchObject({ saved: false, problem: { kind: "denied" } });
    expect(awardMatch(denied, result("m1"))!.awarded).toBe(true);
    expect(denied.state()).toMatchObject({ saved: false, problem: { kind: "denied" } });
    locked.faults.open = false;
    locked.faults.read = true;
    expect(denied.save()).toMatchObject({ saved: false, problem: { kind: "denied" } });
    locked.faults.read = false;
    expect(denied.save()).toMatchObject({ saved: true, problem: null });
    // Nothing that was already on the device is clobbered.
    expect(savedIds(locked.data.get(PROFILE_KEY)).sort()).toEqual(["earlier", "m1"]);
    expect(createProgressStore(() => null).state()).toMatchObject({ saved: false, problem: { kind: "denied" } });

    // A refused write, and a write the browser silently drops, are both "not saved".
    for (const fault of ["write", "drop"] as const) {
      const full = device();
      full.faults[fault] = true;
      const failing = createProgressStore(full.open);
      awardMatch(failing, result("m1"));
      expect(failing.state()).toMatchObject({ saved: false, problem: { kind: "write-failed" } });
      expect(full.data.has(PROFILE_KEY)).toBe(false);
      full.faults[fault] = false;
      expect(failing.save()).toMatchObject({ saved: true, problem: null });
      expect(savedIds(full.data.get(PROFILE_KEY))).toEqual(["m1"]);
    }

    // Eviction while the page is open: said out loud, and restored only when asked.
    const evicting = device();
    const open = createProgressStore(evicting.open);
    awardMatch(open, result("m1"));
    evicting.data.delete(PROFILE_KEY);
    expect(open.save()).toMatchObject({ saved: false, problem: { kind: "evicted" } });
    awardMatch(open, result("m2"));
    expect(evicting.data.has(PROFILE_KEY)).toBe(false);
    expect(open.recover()).toMatchObject({ saved: true, problem: null });
    expect(savedIds(evicting.data.get(PROFILE_KEY))).toEqual(["m1", "m2"]);

    // Eviction between visits: the next visit starts empty and a backup restores it.
    const backup = open.exportBackup();
    const wiped = device();
    const fresh = createProgressStore(wiped.open);
    expect(fresh.state().profile.matches).toEqual([]);
    expect(wiped.data.size).toBe(0);
    expect(fresh.importBackup("{nope")).toMatchObject({ ok: false });
    expect(wiped.data.size).toBe(0);
    expect(fresh.importBackup(backup)).toMatchObject({ ok: true, added: 2, state: { saved: true } });

    // Importing over damaged data is an explicit recovery: the damaged copy is kept.
    const again = device({ [PROFILE_KEY]: damaged });
    expect(createProgressStore(again.open).importBackup(backup)).toMatchObject({ ok: true, state: { saved: true, problem: null } });
    expect(again.data.get(DAMAGED_KEY)).toBe(damaged);
  });

  it("migrates an older save forward and rejects one it has no migration for", () => {
    // No earlier format has shipped; this stand-in proves the chain that the next version will use.
    const older = JSON.stringify({ format: "wreckterra-profile", version: PROFILE_VERSION - 1, results: [record("old")] });
    expect(decodeProfile(older)).toMatchObject({ ok: false, kind: "corrupt" });
    const migrated = decodeProfile(older, { [PROFILE_VERSION - 1]: (data) => ({ ...data, matches: data.results }) });
    expect(migrated).toMatchObject({ ok: true, migrated: true, profile: { matches: [{ id: "old" }] } });
    expect(decodeProfile(encodeProfile({ matches: [record("m1")] }))).toMatchObject({ ok: true, migrated: false });
    for (const text of ["null", "[]", "{}", '{"format":"other","version":1,"matches":[]}']) expect(decodeProfile(text)).toMatchObject({ ok: false, kind: "corrupt" });
  });

  it("WRECK-T5: vehicle unlocks preserve sidegrade budgets and geographic access", async () => {
    const shipped = structuredClone(VEHICLE_SPECS);
    expect(() => assertSidegrades(VEHICLE_SPECS)).not.toThrow();
    const withRivet = (rivet: Partial<VehicleSpec>) => ({ ...VEHICLE_SPECS, rivet: { ...VEHICLE_SPECS.rivet, ...rivet } });
    // Strictly better than the starter, though only just: an upgrade, not a sidegrade.
    const upgrade = withRivet({ ...VEHICLE_SPECS.switchback, maxHealth: VEHICLE_SPECS.switchback.maxHealth + 1 });
    expect(() => assertSidegrades(upgrade)).toThrow(/rivet is at least as good/);
    // Trades speed away, but for far more armour than the budget allows.
    const tank = withRivet({ maxHealth: 400 });
    expect(() => assertSidegrades(tank)).toThrow(/rivet is outside the budget/);
    const empty = createProgressStore(device().open);
    expect(() => garageView(empty.state().profile, upgrade)).toThrow(/rivet/);

    // A new player owns the starter and can test-drive the rest; nothing is ever blocked.
    expect(VEHICLE_KINDS.map((kind) => vehicleAccess(empty.state().profile, kind))).toEqual(["owned", "test-drive", "test-drive"]);
    // A test drive earns points toward the unlock, but no mastery.
    expect(awardMatch(empty, result("t1", { vehicle: "rivet" }))!.record.testDrive).toBe(true);
    expect(garagePoints(empty.state().profile)).toBe(3);
    expect(vehicleMastery(empty.state().profile, "rivet")).toBe(0);
    expect(UNLOCK_POINTS.rivet).toBe(3);
    expect(vehicleAccess(empty.state().profile, "rivet")).toBe("owned");
    expect(vehicleAccess(empty.state().profile, "voltage")).toBe("test-drive");
    expect(awardMatch(empty, result("t2", { vehicle: "rivet" }))!.record.testDrive).toBe(false);
    expect(vehicleMastery(empty.state().profile, "rivet")).toBe(3);
    for (let i = 0; i < 20; i += 1) awardMatch(empty, result(`g${i}`, { vehicle: "voltage" }));
    const rows = garageView(empty.state().profile);
    expect(rows.every((row) => row.access === "owned")).toBe(true);
    expect(rows.find((row) => row.id === "voltage")!.cosmetics.length).toBeGreaterThan(0);

    // Unlocks and mastery leave every car's numbers exactly as shipped.
    expect(VEHICLE_SPECS).toEqual(shipped);
    for (const kind of VEHICLE_KINDS) {
      const car = combat.createCombatMatch({ seed: 1, playerVehicle: kind }).snapshot().vehicles[0]!;
      expect(car.maxHealth).toBe(shipped[kind].maxHealth);
    }

    // In the app, with no progress at all and with a damaged save, any pin plays with any car.
    for (const [saved, name, kind] of [[null, "Voltage", "voltage"], ["{not json", "Rivet", "rivet"]] as [string | null, string, VehicleKind][]) {
      if (saved) localStorage.setItem(PROFILE_KEY, saved);
      const app = await playApp();
      app.tap({ lat: -33.8568, lon: 151.2153 });
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
      await startMatch();
      expect(app.load).toHaveBeenCalledWith({ lat: -33.8568, lon: 151.2153 }, expect.any(Function));
      await waitFor(() => expect(vi.mocked(combat.createCityMatch).mock.calls.at(-1)![1].playerVehicle).toBe(kind));
      cleanup();
    }
  });

  it("stamps the passport for a curated win and for surviving the clock", () => {
    const store = createProgressStore(device().open);
    awardMatch(store, result("lost-there", { status: "lost", reason: "wrecked", passport: "Shibuya, Tokyo" }));
    awardMatch(store, result("elsewhere"));
    expect(passportBadges(store.state().profile)).toEqual([]);
    awardMatch(store, result("won-there", { passport: "Shibuya, Tokyo" }));
    awardMatch(store, result("won-there-again", { passport: "Shibuya, Tokyo" }));
    awardMatch(store, result("lasted", { status: "lost", reason: "time-limit" }));
    expect(passportBadges(store.state().profile)).toEqual(["World Tour: Shibuya, Tokyo", "Survivor: lasted the full clock"]);
  });

  it("WRECK-T5: the running app awards a finished match once, and again only for a new match", async () => {
    await playApp();
    await startMatch();
    const dialog = await endMatch();
    await waitFor(() => expect(dialog.textContent).toContain("+3 garage points"));
    expect(dialog.textContent).toContain("Saved on this device");
    expect(dialog.textContent).toContain("unverified");
    await nextFrames();
    expect(savedIds(localStorage.getItem(PROFILE_KEY))).toHaveLength(1);
    // The curated place the app opened on is stamped.
    expect(localStorage.getItem(PROFILE_KEY)).toContain("Midtown Manhattan, New York");

    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Match results" })).toBeNull());
    await endMatch("lost");
    await waitFor(() => expect(savedIds(localStorage.getItem(PROFILE_KEY))).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Change place" }));
    expect(screen.getByRole("region", { name: "Progress" }).textContent).toContain("Garage points: 4");
  });

  it("WRECK-T5: unsaved progress is saved on renderer loss, page hide and leaving", async () => {
    const real = Storage.prototype.setItem;
    let full = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (full && key === PROFILE_KEY) throw new Error("quota exceeded");
      real.call(this, key, value);
    });
    const interruptions: [string, () => void][] = [
      ["renderer loss", () => { screen.getByLabelText("Combat city").querySelector(".city-battle")!.dispatchEvent(new Event("webglcontextlost")); }],
      ["page hide", () => { window.dispatchEvent(new Event("pagehide")); }],
      ["hidden tab", () => { document.dispatchEvent(new Event("visibilitychange")); }],
      ["leaving", () => { fireEvent.click(screen.getByRole("button", { name: "Change place" })); }],
    ];
    for (const [name, interrupt] of interruptions) {
      full = true;
      await playApp();
      await startMatch();
      const dialog = await endMatch();
      await waitFor(() => expect(dialog.textContent).toContain("Not saved"));
      expect(dialog.textContent).not.toContain("Saved on this device");
      expect(localStorage.getItem(PROFILE_KEY), name).toBeNull();
      full = false;
      act(() => { interrupt(); });
      expect(savedIds(localStorage.getItem(PROFILE_KEY)), name).toHaveLength(1);
      cleanup();
      localStorage.clear();
      ending.status = null;
    }
  });

  it("the garage says what is and is not saved, and offers recovery, export and import", () => {
    const disk = device({ [PROFILE_KEY]: "{not json" });
    const store = createProgressStore(disk.open);
    render(createElement(Garage, { store }));
    const panel = screen.getByRole("region", { name: "Progress" });
    expect(screen.getByRole("alert").textContent).toContain("Not saved");
    expect(panel.textContent).not.toContain("Saved on this device");
    fireEvent.click(screen.getByRole("button", { name: "Keep a copy and start a new save" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(disk.data.get(DAMAGED_KEY)).toBe("{not json");
    expect(panel.textContent).toContain("No saved progress on this device");
    expect(panel.textContent).toContain("Test drive");

    fireEvent.change(screen.getByLabelText("Paste a backup"), { target: { value: "junk" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
    expect(panel.textContent).toContain("not a readable backup");
    fireEvent.change(screen.getByLabelText("Paste a backup"), { target: { value: encodeProfile({ matches: [record("m1")] }) } });
    fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
    expect(panel.textContent).toContain("Restored 1 result");
    expect(panel.textContent).toContain("Saved on this device");
    expect(panel.textContent).toContain("Garage points: 3");

    fireEvent.click(screen.getByRole("button", { name: "Show backup" }));
    const shown = (screen.getByLabelText("Your backup") as HTMLTextAreaElement).value;
    expect(savedIds(shown)).toEqual(["m1"]);

    disk.data.delete(PROFILE_KEY);
    act(() => { store.save(); });
    expect(screen.getByRole("alert").textContent).toContain("disappeared");
    fireEvent.click(screen.getByRole("button", { name: "Save it again" }));
    expect(savedIds(disk.data.get(PROFILE_KEY))).toEqual(["m1"]);
  });

  it("restores a backup chosen as a file", async () => {
    const disk = device();
    render(createElement(Garage, { store: createProgressStore(disk.open) }));
    const file = new File([encodeProfile({ matches: [record("from-file")] })], "backup.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Or choose a backup file"), { target: { files: [file] } });
    await waitFor(() => expect((screen.getByLabelText("Paste a backup") as HTMLTextAreaElement).value).toContain("from-file"));
    fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
    expect(savedIds(disk.data.get(PROFILE_KEY))).toEqual(["from-file"]);
  });
});
