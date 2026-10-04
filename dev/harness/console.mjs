/*
 * Loads a harness URL and prints console errors / page errors (debugging).
 *   node dev/harness/console.mjs /pods?theme=dark
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const BASE = process.env.HARNESS_URL || "http://localhost:5174";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
});
const page = await browser.newPage();
page.on("console", (m) => {
  if (["error", "warning"].includes(m.type())) console.log(`[${m.type()}]`, m.text());
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(BASE + (process.argv[2] || "/pods"));
await new Promise((r) => setTimeout(r, Number(process.env.WAIT || 4000)));
await browser.close();
