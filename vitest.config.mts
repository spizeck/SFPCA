import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // server-only throws when imported outside a React Server
      // Components bundler; under vitest it is a no-op stub.
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "jsdom",
    // Application tests live in tests/. The Firebase rules suite
    // (*.test.mjs) is intentionally excluded — it runs against the
    // emulator via `npm run test:rules`.
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
  },
});
