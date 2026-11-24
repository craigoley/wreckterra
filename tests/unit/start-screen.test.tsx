import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../../src/App";
import type { LiveCityOutcome } from "../../src/maps/tile-city";
import { createPlaceSearch, NOMINATIM_ATTRIBUTION, type PlaceSearch } from "../../src/ui/place-search";
import { MAX_RECENT, normalisePoint, playAreaRing, readRecentPlaces, rememberPlace, type MapFactory } from "../../src/ui/StartScreen";

afterEach(() => { cleanup(); localStorage.clear(); });

/** A map stand-in: records what the screen asks of it and lets a test tap it. */
function fakeMap() {
  let tap: ((point: { lat: number; lon: number }) => void) | null = null;
  const created = vi.fn();
  const factory: MapFactory = async (_element, options) => {
    created();
    tap = options.onPick;
    return { show: () => undefined, destroy: () => undefined };
  };
  return {
    factory,
    ready: () => created.mock.calls.length > 0,
    tap: (point: { lat: number; lon: number }) => { act(() => { tap?.(point); }); },
  };
}

function fakeSearch(): PlaceSearch & { search: ReturnType<typeof vi.fn> } {
  return {
    attribution: NOMINATIM_ATTRIBUTION,
    search: vi.fn(async (query: string) => ({ ok: true as const, places: [{ name: `${query}, France`, lat: 48.8566, lon: 2.3522 }] })),
  };
}

const never = () => new Promise<LiveCityOutcome>(() => undefined);
const refusal: LiveCityOutcome = { ok: false, reason: "The live map tiles could not be fetched (offline). The pinned Midtown city is offered instead.", fallback: "pinned-midtown", notes: [] };

async function open(loadCity: (point: { lat: number; lon: number }) => Promise<LiveCityOutcome> = never) {
  const map = fakeMap();
  const search = fakeSearch();
  const load = vi.fn(loadCity);
  render(<App loadCity={load} search={search} createMap={map.factory} />);
  await waitFor(() => expect(map.ready()).toBe(true));
  return { map, search, load };
}

describe("start screen", () => {
  it("WRECK-T15: only the Play button starts a match", async () => {
    const { map, search, load } = await open();
    // The page opens on the start screen, with no match running behind it.
    expect(screen.getByRole("region", { name: "Start screen" })).toBeTruthy();
    expect(screen.queryByLabelText("Combat city")).toBeNull();
    expect(load).not.toHaveBeenCalled();

    // Tapping the map, picking a suggestion, choosing a car and searching never start anything.
    map.tap({ lat: 48.8584, lon: 2.2945 });
    fireEvent.click(screen.getByRole("button", { name: "The Loop, Chicago" }));
    fireEvent.click(screen.getByRole("button", { name: /Rivet/ }));
    fireEvent.change(screen.getByLabelText("Search for a place"), { target: { value: "Paris" } });
    fireEvent.submit(screen.getByRole("search"));
    await screen.findByRole("button", { name: "Paris, France" });
    fireEvent.click(screen.getByRole("button", { name: "Paris, France" }));
    expect(search.search).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Combat city")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("WRECK-T15: a picked point is passed to the live city loader", async () => {
    const { map, load } = await open();
    map.tap({ lat: 48.8584, lon: 2.2945 });
    expect(screen.getByText("Dropped pin (48.8584, 2.2945)", { selector: "strong" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]![0]).toEqual({ lat: 48.8584, lon: 2.2945 });
    // While the city builds, the loading view names the place.
    expect(screen.getByRole("region", { name: "Loading the city" }).textContent).toContain("Dropped pin (48.8584, 2.2945)");
  });

  it("WRECK-T15: place search runs only on submit and at most once a second", async () => {
    // On screen: typing alone never searches; submitting searches once, and shows the attribution.
    const { search } = await open();
    const box = screen.getByLabelText("Search for a place");
    for (const text of ["P", "Pa", "Par", "Pari", "Paris"]) fireEvent.change(box, { target: { value: text } });
    expect(search.search).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole("search"));
    await screen.findByRole("button", { name: "Paris, France" });
    expect(search.search).toHaveBeenCalledTimes(1);
    expect(search.search).toHaveBeenCalledWith("Paris");
    expect(screen.getByText(NOMINATIM_ATTRIBUTION)).toBeTruthy();

    // In the service: back-to-back searches are spaced a full second apart, and an empty one asks nothing.
    let clock = 0;
    const started: number[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      started.push(clock);
      expect(String(url)).toContain("q=Lagos");
      return new Response(JSON.stringify([{ display_name: "Lagos, Nigeria", lat: "6.5244", lon: "3.3792" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const service = createPlaceSearch({ fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; } });
    const [first, second] = await Promise.all([service.search("Lagos"), service.search("Lagos")]);
    expect(first.ok && second.ok).toBe(true);
    expect(started).toEqual([0, 1000]);
    expect(await service.search("   ")).toEqual({ ok: false, reason: "Type a place name to search." });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("WRECK-T15: a refused place shows its reason and offers Midtown", async () => {
    const { load } = await open(async () => refusal);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not be fetched (offline)");
    expect(screen.getByRole("button", { name: "Choose another place" })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    // Midtown starts the match only when the player presses its button.
    expect(screen.queryByLabelText("Combat city")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Play pinned Midtown" }));
    expect(screen.getByLabelText("Combat city")).toBeTruthy();
    // The results screen is where Restart and Change place live; Change place returns to the start screen.
    expect(screen.queryByRole("dialog", { name: "Match results" })).toBeNull();
  });
});

describe("start screen helpers", () => {
  it("keeps the last five distinct places, newest first", () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); } };
    for (let i = 0; i < 7; i += 1) rememberPlace(storage, { name: `Place ${i}`, lat: i, lon: i });
    rememberPlace(storage, { name: "Place 5 again", lat: 5, lon: 5 });
    const recent = readRecentPlaces(storage);
    expect(recent).toHaveLength(MAX_RECENT);
    expect(recent.map((p) => p.name)).toEqual(["Place 5 again", "Place 6", "Place 4", "Place 3", "Place 2"]);
    expect(readRecentPlaces({ getItem: () => "not json", setItem: () => undefined })).toEqual([]);
  });

  it("wraps a tapped longitude and draws a 700 m play square around the pin", () => {
    expect(normalisePoint({ lat: 10, lon: 190 })).toEqual({ lat: 10, lon: -170 });
    const ring = playAreaRing({ lat: 0, lon: 0 });
    expect(ring[0]).toEqual(ring[4]);
    expect(ring[1]![0] - ring[0]![0]).toBeCloseTo(700 / 111_320, 6);
    expect(ring[2]![1] - ring[1]![1]).toBeCloseTo(700 / 111_320, 6);
  });
});
