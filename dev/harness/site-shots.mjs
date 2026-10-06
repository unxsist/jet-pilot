/*
 * Website screenshots (jet-pilot.app, public/images/app/<name>-<theme>-*):
 * the 15 screens the site shows, in dark + light, as high-density PNG
 * masters. The website repo's `npm run shots -- <masters-dir>` turns them
 * into 1280 / 2400 / 3600 px AVIF + WebP and Retina close-up details.
 *
 *   node dev/harness/site-shots.mjs [name...]
 *
 * Needs the harness (npm run harness; HARNESS_URL, default
 * http://localhost:5174), playwright-core (resolved from PLAYWRIGHT_CORE or
 * NODE_PATH, it is not a project dependency) and a Chromium (CHROMIUM,
 * default /usr/bin/chromium). DEBUG=1 logs each step.
 *
 * Every shot is a 1440x900 macOS window at deviceScaleFactor 6 (DSF), so
 * the masters are 8640x5400: $OUT_DIR (default
 * ~/.cache/jet-pilot/site-masters)/<name>-<theme>.png. THEMES=dark
 * limits the appearances; DSF=1 gives quick 1440x900 drafts.
 *
 * Before each shot the script waits for web fonts, hides the text caret
 * (inputs and Monaco; the terminal's prompt cursor stays, it doesn't blink
 * with reduced motion), waits until no CSS animation or transition is
 * running (infinite ones, like spinners, are left alone) so nothing is
 * caught half-faded or mid-slide, and draws the macOS traffic lights (the
 * real window gets them from the OS). The compositions match the images on
 * the site, whose crops are positioned in percent of the image: keep them
 * pixel-aligned when changing a screen.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");

const BASE = process.env.HARNESS_URL || "http://localhost:5174";
const OUT = process.env.OUT_DIR || `${homedir()}/.cache/jet-pilot/site-masters`;
const DSF = Number(process.env.DSF || 6);
const THEMES = (process.env.THEMES || "dark,light").split(",").filter(Boolean);
const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const debug = process.env.DEBUG ? (...args) => console.error(new Date().toISOString().slice(11, 23), ...args) : () => {};
const DEPLOYMENTS = "/deployments?resource=deployments&kind=Deployment";

/* ------------------------------------------------------------ helpers -- */

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

/* Drags the bottom panel's resize handle by dy (negative: taller panel). */
async function resizePanel(page, dy) {
  const handle = page.locator("[data-panel-resize-handle-id]").first();
  const box = await handle.boundingBox().catch(() => null);
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
  await wait(300);
}

/*
 * Moves the bottom panel's resize handle to y (CSS px from the window top);
 * the tab bar's top edge lands ~1.6 px below it.
 */
async function panelTopAt(page, y) {
  const handle = page.locator("[data-panel-resize-handle-id]").first();
  const box = await handle.boundingBox().catch(() => null);
  if (!box) return;
  await resizePanel(page, y - (box.y + box.height / 2));
}

/* Context switcher: only the given namespaces of a context. */
async function pickNamespaces(page, context, namespaces) {
  await page.locator('[aria-haspopup="menu"]').first().click();
  await wait(400);
  for (const ns of namespaces) {
    await page.locator('[role="menuitem"]', { hasText: context }).first().hover();
    await wait(400);
    await page.locator('[role="menu"]').last().locator('[role="menuitemcheckbox"], [role="menuitem"]', { hasText: new RegExp(`^\\s*${ns}\\s*$`) }).first().click();
    await wait(400);
  }
  await page.keyboard.press("Escape");
  await wait(400);
}

async function editYaml(page, search, replace) {
  await page.evaluate(
    ({ search, replace }) => {
      const model = monaco.editor.getModels().find((m) => m.uri.authority === "jet-pilot");
      const text = model.getValue().replace(new RegExp(search, "m"), replace);
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      const editor = monaco.editor.getEditors().find((e) => e.getModel() === model && e.getContainerDomNode().offsetParent);
      editor?.focus();
    },
    { search, replace }
  );
  await wait(300);
}

/* ------------------------------------------------------------ screens -- */

const screens = {
  pods: {
    url: "/pods?contexts=2",
    ready: "tbody tr td",
    run: async (page) => {
      await pickNamespaces(page, "staging-us-east-2", ["payments", "checkout"]);
      await pickNamespaces(page, "prod-eu-west-1", ["payments", "checkout"]);
      await page.locator("thead th", { hasText: /^\s*Name\s*$/ }).first().click();
      await wait(500);
      await page.mouse.move(5, 890);
    },
  },
  live: { url: "/pods", ready: "tbody tr td", run: async (page) => page.mouse.move(5, 890) },
  "side-panel": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "checkout-api" }).nth(1).click();
      await wait(1200);
    },
  },
  "context-switcher": {
    url: "/pods?contexts=2",
    ready: "tbody tr td",
    run: async (page) => {
      await pickNamespaces(page, "staging-us-east-2", ["payments", "checkout"]);
      await pickNamespaces(page, "prod-eu-west-1", ["payments", "checkout"]);
      await page.locator('[aria-haspopup="menu"]').first().click();
      await wait(400);
      await page.locator('[role="menuitem"]', { hasText: "staging-us-east-2" }).first().hover();
      await wait(900);
    },
  },
  "command-palette": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.mouse.move(5, 890);
      await page.keyboard.press("Meta+k");
      await wait(600);
    },
  },
  editor: {
    url: DEPLOYMENTS,
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Edit");
      await panelTopAt(page, 194);
      await page.waitForSelector(".monaco-editor", { timeout: 20000 }).catch(() => {});
      await page
        .waitForFunction(() => /·/.test(document.querySelector("[data-testid=schema-status]")?.textContent || ""), null, { timeout: 20000 })
        .catch(() => {});
      await wait(800);
      await editYaml(page, "^  replicas: (.*)$", "  replicas: 6");
      await editYaml(page, "^(\\s+)image: (.*):v2.14.3$", "$1image: $2:v2.15.0");
      await page.keyboard.press("Meta+s");
      await page.waitForFunction(() => /passed/.test(document.querySelector("[data-testid=dry-run-status]")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
      await wait(500);
      // The edits leave the cursor in the first lines, which keeps them
      // expanded: fold every unchanged region (13 / 9 / 68 hidden lines).
      await page.evaluate(() => {
        for (const diff of monaco.editor.getDiffEditors()) diff.collapseAllUnchangedRegions?.();
      });
      await page.mouse.move(5, 890);
      await wait(1500);
    },
  },
  graph: {
    url: "/cluster-overview",
    ready: ".vue-flow__node-k8s",
    settle: 2500,
    run: async (page) => {
      await page
        .locator(".vue-flow__node-k8s")
        .filter({ hasText: "checkout-api" })
        .filter({ has: page.locator(".graph-card__meta", { hasText: "Deployment" }) })
        .first()
        .click();
      // Resting on the sidebar: its scrollbar shows.
      await page.mouse.move(5, 500);
      await wait(1500);
    },
  },
  logs: {
    url: DEPLOYMENTS,
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Logs", "All pods");
      await panelTopAt(page, 164);
      await page.mouse.move(5, 890);
      await wait(2500);
    },
  },
  rollouts: {
    url: DEPLOYMENTS,
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Rollout history");
      await panelTopAt(page, 164);
      await wait(1500);
    },
  },
  terminal: {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.keyboard.press("Control+Backquote");
      await page.mouse.move(5, 890);
      await wait(1500);
    },
  },
  "clusters-hub": {
    url: "/clusters?scenario=hub",
    ready: "[role=grid]",
    settle: 3500,
    run: async (page) => {
      await page.getByText("Checkout", { exact: true }).first().click();
      await wait(800);
    },
  },
  "add-cloud": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.mouse.move(5, 890);
      await page.keyboard.press("Meta+n");
      await wait(800);
    },
  },
  "sign-in": {
    url: "/clusters?scenario=clouds&ssowait=1",
    ready: "body",
    settle: 2500,
    run: async (page) => {
      await page.keyboard.press("Meta+n");
      await wait(800);
      const dialog = page.getByRole("dialog");
      await dialog.getByText("AWS", { exact: true }).first().click();
      await wait(600);
      await dialog.getByText("IAM Identity Center").first().click();
      await wait(600);
      await dialog.getByRole("button", { name: /Sign in/ }).first().click();
      await wait(1500);
    },
  },
  "themes-library": {
    url: "/settings/appearance",
    ready: "[data-theme-card]",
    settle: 2500,
    run: async (page) => {
      // Scrolled to the library; hovering Rosé Pine previews it on the app.
      await page.evaluate((top) => {
        const card = document.querySelector("[data-theme-card]");
        const scroller = card?.closest(".overflow-auto");
        if (card && scroller) scroller.scrollTop += card.getBoundingClientRect().top - top;
      }, 135.5);
      await wait(400);
      await page.getByRole("button", { name: "Rosé Pine. Use this theme" }).hover();
      await wait(1500);
    },
  },
  workspaces: {
    url: `${DEPLOYMENTS}&contexts=2`,
    ready: "tbody tr td",
    run: async (page) => {
      // The working set: a describe and a logs tab, saved as a workspace
      // from the command palette (Workspace 1, active).
      await openRowAction(page, "payments-api", "Describe");
      await openRowAction(page, "payments-api", "Logs", "All pods");
      await page.keyboard.press("Meta+k");
      await wait(400);
      await page.keyboard.type("Switch workspace");
      await wait(300);
      await page.keyboard.press("Enter");
      await wait(400);
      await page.getByText("Save current as new workspace").first().click();
      await wait(600);
      // Name it and add three more (state.json, read on the next load).
      await page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((k) => /^harness-fs:.*state\.json$/.test(k));
        const state = JSON.parse(sessionStorage.getItem(key));
        const [mine] = state.workspaces;
        const kubeConfig = mine.contexts[0].kubeConfig;
        const ctx = (context, namespaces = ["all"]) => ({ context, kubeConfig, namespaces });
        const now = Date.now();
        const workspace = (id, name, contexts, tabs) => ({
          id,
          name,
          contexts,
          tabs: { tabs, activeTabId: tabs[0]?.id ?? null },
          portForwardProfileIds: [],
          route: mine.route,
          updatedAt: now,
        });
        state.workspaces = [
          { ...mine, name: "Payments on-call" },
          workspace("ws-checkout", "Checkout incident", [ctx("prod-eu-west-1", ["checkout"])], mine.tabs.tabs.slice(0, 1)),
          workspace("ws-staging", "Staging rollout", [ctx("staging-us-east-2")], []),
          workspace("ws-platform", "Platform & ingress", [ctx("prod-eu-west-1"), ctx("staging-us-east-2")], []),
        ];
        state.activeWorkspaceId = mine.id;
        sessionStorage.setItem(key, JSON.stringify(state));
      });
      await page.reload();
      await page.waitForSelector("tbody tr td", { timeout: 20000 });
      await page.evaluate(() => document.fonts.ready);
      await wait(1500);
      // Describe on the left, logs on the right.
      await page.getByRole("tab", { name: /deployment\/payments-api/ }).first().click().catch(() => {});
      await wait(400);
      await page.getByRole("button", { name: "Split view" }).click();
      await wait(800);
      await page.getByRole("button", { name: /Payments on-call/ }).first().click();
      await wait(800);
    },
  },
};

/* ----------------------------------------------------------- settling -- */

const SETTLE_CSS = `
  *, *::before, *::after { caret-color: transparent !important; }
  .monaco-editor .cursors-layer .cursor { visibility: hidden !important; }
`;

/* Fonts loaded, caret hidden, no finite animation or transition running. */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: SETTLE_CSS });
  for (let i = 0; i < 100; i++) {
    const busy = await page.evaluate(
      () =>
        document.getAnimations().filter((a) => {
          if (a.playState !== "running") return false;
          const timing = a.effect?.getComputedTiming?.();
          return timing && timing.iterations !== Infinity && timing.endTime !== Infinity;
        }).length
    );
    if (!busy) break;
    await wait(100);
  }
  // Chromium drops a backdrop-filter whose surface is this wide (above
  // ~4.3k device px), so a dialog's blurred backdrop came out sharp: blur
  // the app itself instead (the overlay still dims it).
  await page.evaluate(() => {
    const app = document.getElementById("app");
    for (const el of document.querySelectorAll("body > *")) {
      const { backdropFilter } = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (!backdropFilter || backdropFilter === "none") continue;
      if (rect.width < innerWidth || rect.height < innerHeight) continue;
      el.style.setProperty("backdrop-filter", "none", "important");
      app.style.setProperty("filter", backdropFilter, "important");
    }
  });
  await page.evaluate(() => {
    if (document.getElementById("site-shot-lights")) return;
    const box = document.createElement("div");
    box.id = "site-shot-lights";
    box.style.cssText = "position:fixed;left:15.6px;top:15.6px;display:flex;gap:7.8px;z-index:2147483647;pointer-events:none";
    for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
      const dot = document.createElement("span");
      dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.18)`;
      box.appendChild(dot);
    }
    document.body.appendChild(box);
  });
  // Two frames so the last styles are painted.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await wait(250);
}

/*
 * In a worktree whose node_modules is a symlink, Vite asks for a few assets
 * (the web fonts) by their real path (/@fs/<elsewhere>/node_modules/...),
 * outside its serving allow list: on a 403, ask for the same file through
 * the worktree's own node_modules.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
async function serveSymlinkedModules(page) {
  await page.route(/\/@fs\/.*\/node_modules\//, async (route) => {
    const response = await route.fetch().catch(() => null);
    if (response && response.status() !== 403) return route.fulfill({ response });
    const url = new URL(route.request().url());
    const rest = url.pathname.split("/node_modules/").slice(1).join("/node_modules/");
    return route.continue({ url: `${url.origin}/@fs${ROOT}/node_modules/${rest}${url.search}` });
  });
}

/* --------------------------------------------------------------- main -- */

/*
 * Playwright makes Chromium keep its shared memory in /tmp
 * (--disable-dev-shm-usage). At DSF 6 the frames and the 8640x5400 readback
 * outgrow a small /tmp tmpfs and the renderer dies ("Target crashed", the
 * graph already on load): use /dev/shm.
 */
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--font-render-hinting=none", "--disable-gpu"],
  ignoreDefaultArgs: ["--disable-dev-shm-usage"],
});

const results = [];
for (const [name, screen] of Object.entries(screens)) {
  if (only.length && !only.includes(name)) continue;
  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: DSF,
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await serveSymlinkedModules(page);
    page.on("pageerror", (e) => console.error(`[${name}/${theme}] pageerror`, e.message));
    const url = new URL(BASE + screen.url);
    if (!url.searchParams.get("scenario")) url.searchParams.set("scenario", "default");
    url.searchParams.set("theme", theme);
    url.searchParams.set("os", "macos");
    try {
      debug(name, theme, "goto");
      await page.goto(url.toString());
      await page.waitForSelector(screen.ready, { timeout: 20000 }).catch(() => {
        console.error(`[${name}/${theme}] ready selector timed out: ${screen.ready}`);
      });
      await page.evaluate(() => document.fonts.ready);
      await wait(screen.settle ?? 1200);
      debug(name, theme, "run");
      if (screen.run) await screen.run(page, theme);
      debug(name, theme, "settle");
      await settle(page);
      debug(name, theme, "capture");
      const file = `${OUT}/${name}-${theme}.png`;
      await page.screenshot({ path: file, timeout: 120000 });
      results.push(file);
      console.error(`[${name}/${theme}] ok`);
    } catch (e) {
      console.error(`[${name}/${theme}] failed`, e.message);
    }
    await context.close().catch(() => {});
  }
}
await browser.close();
console.log(results.join("\n"));
