import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// The pump SDKs' ESM builds pull in agent-payments-sdk, whose ESM build imports
// `BN` from anchor's CJS entry and crashes. Their CJS builds are fine, which is
// what the app itself runs, so tests use those too.
export default defineConfig({
  resolve: {
    alias: {
      "@pump-fun/pump-sdk": resolve(__dirname, "node_modules/@pump-fun/pump-sdk/dist/index.js"),
      "@pump-fun/pump-swap-sdk": resolve(__dirname, "node_modules/@pump-fun/pump-swap-sdk/dist/index.js"),
    },
  },
  test: { testTimeout: 30_000, hookTimeout: 30_000, fileParallelism: false },
});
