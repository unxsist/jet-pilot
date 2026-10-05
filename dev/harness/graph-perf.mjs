/*
 * Resource graph performance on the large scenario (2,000+ objects):
 *
 *   node dev/harness/graph-perf.mjs [--polling] [--runs=3]
 *
 * - load: navigation -> first card on screen
 * - search: typing a query -> matches highlighted (next paint)
 * - select: Enter on the first result -> selection + neighbourhood lit
 * - zoom: frame times of a wheel zoom from ~75% to the overview and back
 * - delta: a live change (workload loses its replicas) -> card turns red
 *
 * Needs the harness (npm run harness, HARNESS_URL) and playwright-core
 * (PLAYWRIGHT_CORE or NODE_PATH) with a Chromium (CHROMIUM).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");

const BASE = process.env.HARNESS_URL || "http://localhost:5174";
const polling = process.argv.includes("--polling");
const runs = Number(
  (process.argv.find((a) => a.startsWith("--runs=")) || "--runs=3").slice(7)
);
const QUERY = "billing-worker";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--font-render-hinting=none"],
});

const results = { load: [], search: [], select: [], zoomAvg: [], zoomP95: [], zoomWorst: [], delta: [] };

for (let run = 0; run < runs; run++) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  const started = Date.now();
  await page.goto(
    `${BASE}/cluster-overview?scenario=large-graph&theme=dark&polling=${polling ? 1 : 0}&fresh=1`
  );
  await page.waitForSelector(".vue-flow__node-k8s", { timeout: 60000 });
  results.load.push(Date.now() - started);
  await wait(2500);

  /* Zoom from ~75% to the overview and back (wheel over the canvas). */
  const box = await page.locator(".vue-flow").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const frames = [];
    let last = performance.now();
    window.__frames = frames;
    window.__frameLoop = true;
    const loop = (now) => {
      frames.push(now - last);
      last = now;
      if (window.__frameLoop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  for (const direction of [1, -1]) {
    for (let i = 0; i < 32; i++) {
      await page.mouse.wheel(0, direction * 40);
      await wait(16);
    }
    await wait(400);
  }
  const frames = await page.evaluate(() => {
    window.__frameLoop = false;
    return window.__frames.slice(2);
  });
  const sorted = [...frames].sort((a, b) => a - b);
  results.zoomAvg.push(frames.reduce((s, f) => s + f, 0) / frames.length);
  results.zoomP95.push(sorted[Math.floor(sorted.length * 0.95)]);
  results.zoomWorst.push(sorted[sorted.length - 1]);
  await wait(800);

  /* Search -> highlight, Enter -> selection lit. */
  const timing = await page.evaluate(async (query) => {
    const paint = () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 0))
      );
    const until = async (predicate, timeout = 15000) => {
      const start = performance.now();
      while (!predicate()) {
        if (performance.now() - start > timeout) return false;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return true;
    };
    const input = document.querySelector('input[aria-label="Find an object"]');
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    ).set;
    const t0 = performance.now();
    setter.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => document.querySelector("#graph-search-results"));
    await paint();
    const search = performance.now() - t0;

    const t1 = performance.now();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    const selectedCard = () =>
      document.querySelector(
        ".graph-card--selected, .graph-card.ring-primary\\/30"
      );
    await until(selectedCard);
    await paint();
    const select = performance.now() - t1;
    return { search, select };
  }, QUERY);
  results.search.push(timing.search);
  results.select.push(timing.select);
  await wait(1500);

  /* Live delta: the selected workload loses its replicas. */
  const delta = await page.evaluate(async (name) => {
    const card = () =>
      [...document.querySelectorAll(".vue-flow__node-k8s")].find(
        (el) =>
          el.querySelector(".graph-card__name")?.textContent?.trim() === name &&
          el.textContent.includes("Deployment")
      );
    if (!card()) return -1;
    const t0 = performance.now();
    window.__harnessMutate("deployments", name, (d) => ({
      ...d,
      status: { ...d.status, availableReplicas: 0, readyReplicas: 0 },
    }));
    while (card()?.querySelector(".graph-card")?.dataset.health !== "error") {
      if (performance.now() - t0 > 30000) return -2;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return performance.now() - t0;
  }, QUERY);
  results.delta.push(delta);
  await context.close();
}
await browser.close();

const fmt = (values) =>
  `median ${median(values).toFixed(1)} ms  [${values.map((v) => v.toFixed(0)).join(", ")}]`;
console.log(`mode: ${polling ? "kubectl polling" : "watch"}  runs: ${runs}`);
console.log(`load            ${fmt(results.load)}`);
console.log(`search->matches ${fmt(results.search)}`);
console.log(`enter->selected ${fmt(results.select)}`);
console.log(`zoom avg frame  ${fmt(results.zoomAvg)}`);
console.log(`zoom p95 frame  ${fmt(results.zoomP95)}`);
console.log(`zoom worst      ${fmt(results.zoomWorst)}`);
console.log(`delta->visible  ${fmt(results.delta)}`);
