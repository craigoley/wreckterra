import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../../src/App";
import { parseCity } from "../../src/maps/midtown";
import type { LiveCityOutcome } from "../../src/maps/tile-city";
import * as combat from "../../src/sim/combat";
import { NOMINATIM_ATTRIBUTION, type PlaceSearch } from "../../src/ui/place-search";
import { DIFFICULTY_KEY, readDifficulty, type MapFactory } from "../../src/ui/StartScreen";

vi.mock("../../src/sim/combat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sim/combat")>();
  return { ...actual, createCityMatch: vi.fn(actual.createCityMatch) };
});

afterEach(() => { cleanup(); localStorage.clear(); vi.mocked(combat.createCityMatch).mockClear(); });

const city = parseCity(JSON.parse(readFileSync("public/maps/midtown/city.json", "utf8")));
const search: PlaceSearch = { attribution: NOMINATIM_ATTRIBUTION, search: async () => ({ ok: true as const, places: [] }) };
const map: MapFactory = async () => ({ show: () => undefined, destroy: () => undefined });
const loaded: LiveCityOutcome = { ok: true, city, from: "cache", stats: null, notes: [] };

function open() {
  const load = vi.fn(async () => loaded);
  render(<App loadCity={load} search={search} createMap={map} />);
  return load;
}

const radio = (name: string) => screen.getByRole("radio", { name: new RegExp(name) }) as HTMLInputElement;

describe("WRECK-T18: the difficulty picker on the start screen", () => {
  it("WRECK-T18: the start screen defaults to easy", () => {
    open();
    expect(screen.getByRole("radiogroup", { name: "Difficulty" })).toBeTruthy();
    expect(radio("Easy").checked).toBe(true);
    expect(radio("Normal").checked).toBe(false);
    expect(radio("Hard").checked).toBe(false);
    cleanup();

    // A saved pick comes back; a value that is not a level, or storage that throws, is Easy.
    localStorage.setItem(DIFFICULTY_KEY, "hard");
    open();
    expect(radio("Hard").checked).toBe(true);
    cleanup();
    expect(readDifficulty({ getItem: () => "impossible", setItem: () => undefined })).toBe("easy");
    expect(readDifficulty({ getItem: () => { throw new Error("storage is blocked"); }, setItem: () => undefined })).toBe("easy");
    expect(readDifficulty(null)).toBe("easy");
  });

  it("WRECK-T18: the picked difficulty reaches the match", async () => {
    const load = open();
    const create = vi.mocked(combat.createCityMatch);
    // Choosing a level only selects it and saves it: no city is loaded and no match starts.
    fireEvent.click(radio("Hard"));
    expect(radio("Hard").checked).toBe(true);
    expect(localStorage.getItem(DIFFICULTY_KEY)).toBe("hard");
    expect(load).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Combat city")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await screen.findByLabelText("Combat city");
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls.at(-1)![1].difficulty).toBe("hard");
  });
});
