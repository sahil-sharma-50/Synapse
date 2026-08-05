import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node environment: these tests cover the pure modules (geometry, formatting,
    // catalogues). Component tests would need jsdom plus a Tauri IPC stub, which
    // is a bigger lift than it is worth for windows that are mostly event wiring.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
