import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Durable Object classes import this runtime-only module; tests get a minimal stand-in.
    alias: { "cloudflare:workers": fileURLToPath(new URL("./tests/support/cloudflare-workers.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: { reporter: ["text", "html"] },
  },
});
