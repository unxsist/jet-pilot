/*
 * Bundle analysis: `npm run analyze` builds the app with this config.
 *
 * Writes an interactive treemap (dist/stats.html) and the raw module data
 * (dist/stats.json, read by `scripts/check-bundle-size.mjs --explain`).
 * An .mts file because rollup-plugin-visualizer is ESM-only and
 * vite.config.ts is bundled as CommonJS.
 */
import { mergeConfig, type PluginOption } from "vite";
import { visualizer } from "rollup-plugin-visualizer";
import baseConfig from "./vite.config";

export default mergeConfig(baseConfig, {
  plugins: [
    visualizer({ filename: "dist/stats.html", gzipSize: true }) as PluginOption,
    visualizer({
      filename: "dist/stats.json",
      template: "raw-data",
    }) as PluginOption,
  ],
});
