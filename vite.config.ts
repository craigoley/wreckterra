import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", include: ["tests/unit/**/*.test.{ts,tsx}"], passWithNoTests: false,
    coverage: { provider: "v8", include: ["src/App.tsx", "src/game/VehicleScene.tsx"], reporter: ["text", "json-summary", "lcov"] } },
});
