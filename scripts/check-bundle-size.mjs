#!/usr/bin/env node
/*
 * Bundle-size budget check (CI friendly, no dependencies).
 *
 *   npm run vite:build && npm run size:check
 *   node scripts/check-bundle-size.mjs [--dist dist] [--json] [--explain]
 *
 * "Initial" = everything index.html loads before the app can render: the
 * entry script, its modulepreloaded static imports and the stylesheets.
 * Sizes are gzip (level 9), the budgets live in bundle-budget.json.
 * Exits 1 when a budget is exceeded.
 *
 * --explain  lists the biggest modules of the initial chunks; needs
 *            dist/stats.json from `npm run analyze`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const root = resolve(new URL("..", import.meta.url).pathname);
const dist = resolve(root, option("--dist", "dist"));
const budget = JSON.parse(
  readFileSync(join(root, "bundle-budget.json"), "utf8")
);

if (!existsSync(join(dist, "index.html"))) {
  console.error(`No build found in ${dist}: run \`npm run vite:build\` first.`);
  process.exit(2);
}

const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;
const gzip = (file) => gzipSync(readFileSync(file), { level: 9 }).length;

const html = readFileSync(join(dist, "index.html"), "utf8");
const refs = new Set();
for (const match of html.matchAll(
  /<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g
)) {
  const url = match[1];
  if (/\.(m?js|css)$/.test(url) && !/^https?:/.test(url)) {
    refs.add(url.replace(/^\//, ""));
  }
}

const initial = [...refs]
  .filter((ref) => existsSync(join(dist, ref)))
  .map((ref) => {
    const file = join(dist, ref);
    return {
      file: ref,
      type: extname(ref) === ".css" ? "css" : "js",
      raw: statSync(file).size,
      gzip: gzip(file),
    };
  });

const assetsDir = join(dist, "assets");
const allAssets = readdirSync(assetsDir).map((name) => {
  const file = join(assetsDir, name);
  const isText = /\.(m?js|css)$/.test(name);
  return {
    file: `assets/${name}`,
    raw: statSync(file).size,
    gzip: isText ? gzip(file) : statSync(file).size,
    type: extname(name).slice(1),
  };
});

const sum = (list, key) => list.reduce((total, a) => total + a[key], 0);
const initialJs = initial.filter((a) => a.type === "js");
const initialCss = initial.filter((a) => a.type === "css");
const jsChunks = allAssets.filter((a) => a.type === "js");
const largestJs = jsChunks.reduce((max, a) => (a.gzip > max.gzip ? a : max), {
  gzip: 0,
});
const media = allAssets.filter((a) =>
  /^(gif|png|jpe?g|webp|webm|mp4|avif)$/.test(a.type)
);
const largestMedia = media.reduce((max, a) => (a.raw > max.raw ? a : max), {
  raw: 0,
});

const metrics = {
  initialJsGzipKb: kb(sum(initialJs, "gzip")),
  initialJsRawKb: kb(sum(initialJs, "raw")),
  initialCssGzipKb: kb(sum(initialCss, "gzip")),
  initialRequests: initial.length,
  largestJsChunkGzipKb: kb(largestJs.gzip),
  largestJsChunk: largestJs.file,
  largestMediaKb: kb(largestMedia.raw),
  largestMedia: largestMedia.file,
  totalJsGzipKb: kb(sum(jsChunks, "gzip")),
  totalAssetsKb: kb(sum(allAssets, "raw")),
};

const checks = [
  ["initialJsGzipKb", "Initial JS (gzip)"],
  ["initialCssGzipKb", "Initial CSS (gzip)"],
  ["largestJsChunkGzipKb", "Largest JS chunk (gzip)"],
  ["largestMediaKb", "Largest image / video"],
  ["totalAssetsKb", "All assets (raw)"],
].filter(([key]) => budget[key] !== undefined);

const failures = checks.filter(([key]) => metrics[key] > budget[key]);

if (flag("--json")) {
  console.log(JSON.stringify({ metrics, budget, initial, failures }, null, 2));
} else {
  console.log("Initial assets (loaded by index.html):");
  for (const a of initial.sort((x, y) => y.gzip - x.gzip)) {
    console.log(
      `  ${a.file.padEnd(52)} ${String(kb(a.raw)).padStart(8)} kB  ${String(
        kb(a.gzip)
      ).padStart(7)} kB gzip`
    );
  }
  console.log("");
  for (const [key, label] of checks) {
    const ok = metrics[key] <= budget[key];
    console.log(
      `${ok ? "ok  " : "FAIL"}  ${label.padEnd(26)} ${String(
        metrics[key]
      ).padStart(8)} kB  (budget ${budget[key]} kB)`
    );
  }
  console.log(
    `\nLargest JS chunk: ${metrics.largestJsChunk}; largest media: ${metrics.largestMedia}`
  );
}

if (flag("--explain")) {
  const statsFile = join(dist, "stats.json");
  if (!existsSync(statsFile)) {
    console.error("\n--explain needs dist/stats.json: run `npm run analyze`.");
  } else {
    const stats = JSON.parse(readFileSync(statsFile, "utf8"));
    const initialNames = new Set(initialJs.map((a) => a.file));
    const sizes = new Map();
    const walk = (node, chunk) => {
      const part = node.uid && stats.nodeParts[node.uid];
      if (part && initialNames.has(chunk)) {
        let id = stats.nodeMetas[part.metaUid].id;
        if (id.includes("node_modules/")) {
          const rest = id.split("node_modules/").pop().split("/");
          id = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
        }
        sizes.set(id, (sizes.get(id) || 0) + part.renderedLength);
      }
      (node.children || []).forEach((child) => walk(child, chunk));
    };
    stats.tree.children.forEach((chunk) => walk(chunk, chunk.name));
    console.log("\nBiggest modules in the initial chunks (rendered, pre-minify):");
    [...sizes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .forEach(([id, size]) =>
        console.log(`  ${String(kb(size)).padStart(8)} kB  ${id}`)
      );
  }
}

if (failures.length > 0) {
  console.error(
    `\nBundle budget exceeded: ${failures.map(([, l]) => l).join(", ")}`
  );
  process.exit(1);
}
