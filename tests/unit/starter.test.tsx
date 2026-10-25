import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import App from "../../src/App";
afterEach(cleanup);
describe("repository starter", () => {
  it("exposes the garage, portfolio link and truthful development state", () => {
    render(<App />);
    expect(screen.getByRole("link", { name: /OleyArcade/ }).getAttribute("href")).toBe("https://www.oleyarcade.com/");
    expect(screen.getByRole("group", { name: "Choose a vehicle" })).toBeTruthy();
    expect(screen.getByText(/driving prototype is in development/)).toBeTruthy();
  });
  it("updates the visible vehicle and accessible selection together", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Rivet/ }));
    expect(screen.getByRole("button", { name: /Rivet/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Switchback/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("img", { name: "Rivet vehicle preview" })).toBeTruthy();
    expect(screen.getByText("5 / 5")).toBeTruthy();
  });
});
