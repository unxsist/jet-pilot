/*
 * Dev-only visual QA harness: the app with mocked Tauri IPC, in a browser.
 *
 *   npm run harness   -> http://localhost:5174/pods?theme=dark
 *
 * Extends the app's Vite config and injects ./setup.ts ahead of src/main.ts.
 * The production config (vite.config.ts) never references this directory.
 */
import { defineConfig, mergeConfig, type Plugin } from "vite";
import baseConfig from "../../vite.config";

const injectHarness = (): Plugin => ({
  name: "jet-pilot-harness",
  // A module script in <head> runs before the app entry in <body>.
  transformIndexHtml: {
    order: "pre",
    handler: () => [
      {
        tag: "script",
        attrs: { type: "module", src: "/dev/harness/setup.ts" },
        injectTo: "head",
      },
    ],
  },
});

// Drop the Vue devtools overlay: it would show up in every screenshot.
const basePlugins = ((baseConfig.plugins || []) as unknown[])
  .flat(Infinity)
  .filter(
    (plugin) =>
      !String((plugin as Plugin | null)?.name || "").includes("devtools") &&
      !String((plugin as Plugin | null)?.name || "").includes("inspector")
  ) as Plugin[];

export default mergeConfig(
  { ...(baseConfig as Record<string, unknown>), plugins: basePlugins },
  defineConfig({
    plugins: [injectHarness()],
    server: { port: 5174, strictPort: true },
  })
);
