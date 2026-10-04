/*
 * Screenshots key screens of the harness (npm run harness) in dark + light.
 *
 *   node dev/harness/shoot.mjs <prefix> [screen...]
 *
 * Needs playwright-core (resolved from PLAYWRIGHT_CORE or NODE_PATH, it is
 * not a project dependency) and a Chromium (CHROMIUM, default
 * /usr/bin/chromium). Output: $OUT_DIR (default /tmp/jet-ui-shots)/<prefix>-<screen>-<theme>.png
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");

const BASE = process.env.HARNESS_URL || "http://localhost:5174";
const OUT = process.env.OUT_DIR || "/tmp/jet-ui-shots";
const prefix = process.argv[2] || "shot";
const only = process.argv.slice(3);
mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const firstRow = (page) => page.locator("tbody tr").filter({ hasText: /\w/ }).first();

const screens = {
  pods: { url: "/pods", ready: "tbody tr td" },
  deployments: { url: "/deployments?resource=deployments&kind=Deployment", ready: "tbody tr td" },
  helm: { url: "/helm-releases?resource=release&kind=Release", ready: "tbody tr td" },
  "side-panel": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "checkout-api" }).nth(1).click();
      await wait(1200);
    },
  },
  "context-switcher": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator('[aria-haspopup="menu"]').first().click();
      await wait(400);
      await page.locator('[role="menuitem"]', { hasText: "prod-eu-west-1" }).first().hover();
      await wait(900);
    },
  },
  "command-palette": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.keyboard.press("Control+k");
      await wait(600);
    },
  },
  "cluster-overview": { url: "/cluster-overview", ready: ".vue-flow__node", settle: 2500 },
  yaml: {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Edit");
      await page.waitForSelector(".monaco-editor", { timeout: 20000 }).catch(() => {});
      await wait(1500);
    },
  },
  logs: {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Logs", "All containers");
      await wait(2000);
    },
  },
  terminal: {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Shell", null);
      await wait(1500);
    },
  },
  describe: {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Describe");
      await wait(1500);
    },
  },
  settings: { url: "/settings/general", ready: "main, form, h1, h2", settle: 1200 },
  "settings-appearance": { url: "/settings/appearance", ready: "body", settle: 1200 },
  empty: { url: "/pods?scenario=empty", ready: "table", settle: 1500 },
  error: { url: "/pods?scenario=error", ready: "[role=alert]", settle: 800 },
  "no-context": { url: "/pods?scenario=nocontext", ready: "body", settle: 1500 },
  "port-forward-dialog": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Port Forward");
      await wait(900);
    },
  },
  "delete-dialog": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "checkout-api", "Kill");
      await wait(900);
    },
  },
};

async function openRowAction(page, rowText, action, sub) {
  const row = page.locator("tbody tr", { hasText: rowText }).first();
  await row.click({ button: "right" });
  await wait(300);
  const item = page.locator('[role="menuitem"]', { hasText: new RegExp(`^\\s*${action}\\b`) }).first();
  if (sub !== undefined) {
    await item.hover();
    await wait(300);
    const subItem = sub
      ? page.locator('[role="menuitem"]', { hasText: sub }).first()
      : page.locator('[role="menu"]').last().locator('[role="menuitem"]').first();
    await subItem.click();
  } else {
    await item.click();
  }
  await wait(500);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--font-render-hinting=none", "--disable-gpu"],
});

const results = [];
for (const theme of ["dark", "light"]) {
  for (const [name, screen] of Object.entries(screens)) {
    if (only.length && !only.includes(name)) continue;
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error(`[${name}/${theme}] pageerror`, e.message));
    const scenario = new URL(BASE + screen.url).searchParams.get("scenario") || "default";
    const sep = screen.url.includes("?") ? "&" : "?";
    try {
      await page.goto(`${BASE}${screen.url}${sep}theme=${theme}&scenario=${scenario}&os=linux`);
      await page.waitForSelector(screen.ready, { timeout: 15000 }).catch(() => {
        console.error(`[${name}/${theme}] ready selector timed out: ${screen.ready}`);
      });
      await wait(screen.settle ?? 900);
      if (screen.run) await screen.run(page);
      const file = `${OUT}/${prefix}-${name}-${theme}.png`;
      await page.screenshot({ path: file });
      results.push(file);
    } catch (e) {
      console.error(`[${name}/${theme}] failed`, e.message);
    }
    await context.close();
  }
}
await browser.close();
console.log(results.join("\n"));
