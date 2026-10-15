import vue from "@vitejs/plugin-vue";
import { resolve } from "path";
import AutoImport from "unplugin-auto-import/vite";
import { defineConfig } from "vitest/config";
import svgLoader from "vite-svg-loader";
import VueDevTools from "vite-plugin-vue-devtools";
import { splitBundledModules } from "./scripts/split-module.mjs";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    svgLoader(),
    AutoImport({
      imports: ["vue"],
      dts: "./src/auto-imports.d.ts",
      eslintrc: {
        enabled: true,
        filepath: resolve(__dirname, ".eslintrc-auto-import.json"),
      },
    }),
    VueDevTools(),
    // radix-vue ships as one file; split it so lazy screens keep their
    // primitives out of the startup chunk (see scripts/split-module.mjs).
    splitBundledModules(/\/node_modules\/radix-vue\/dist\/index\.js$/),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "./dist",
    // See https://tauri.app/v1/references/webview-versions for details
    target: ["es2021", "chrome100", "safari14"],
    minify: !!!process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        /*
         * Everything index.html loads anyway goes into one chunk. Left to
         * itself, rolldown spreads the startup modules over dozens of small
         * shared chunks (one per set of lazy importers), and each costs
         * import/export glue and gzip context; with radix-vue split into
         * parts that's ~30 files. Lazy chunks are unaffected.
         */
        codeSplitting: {
          groups: [{ name: "startup", tags: ["$initial"] }],
        },
      },
    },
  },
  test: {
    include: ["tests/unit/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
  },
});
