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
  "cluster-overview": { url: "/cluster-overview", ready: ".vue-flow__node-k8s", settle: 2500 },
  "graph-problems": {
    url: "/cluster-overview",
    ready: ".vue-flow__node-k8s",
    settle: 2000,
    run: async (page) => {
      await page.keyboard.press("p");
      await wait(900);
    },
  },
  "graph-focus": {
    url: "/cluster-overview",
    ready: ".vue-flow__node-k8s",
    settle: 2000,
    run: async (page) => {
      await page
        .locator(".vue-flow__node-k8s")
        .filter({ hasText: "checkout-api" })
        .filter({ has: page.locator(".graph-card__meta", { hasText: "Deployment" }) })
        .first()
        .dblclick();
      await page.mouse.move(5, 500);
      await wait(1200);
    },
  },
  "graph-large": { url: "/cluster-overview?scenario=large-graph", ready: ".vue-flow__node-k8s", settle: 3000 },
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
  events: { url: "/events?resource=events&kind=Event", ready: "tbody tr td" },
  nodes: { url: "/nodes?resource=nodes&kind=Node", ready: "tbody tr td" },
  "row-menu": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.locator("tbody tr", { hasText: "checkout-api" }).nth(1).click({ button: "right" });
      await wait(500);
    },
  },
  selection: {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      for (const i of [1, 2, 4]) {
        await page.locator("tbody tr").nth(i).hover();
        await page.locator("tbody tr").nth(i).locator('[role="checkbox"]').click();
      }
      await wait(500);
    },
  },
  "port-forwards": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await page.getByRole("button", { name: /Port forwarding/ }).click();
      await wait(700);
    },
  },
  macos: { url: "/deployments?resource=deployments&kind=Deployment&os=macos", ready: "tbody tr td" },
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
  /* ----------------------------------------------- editor (G4) -- */
  "editor-schema": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await editYaml(page, "^(\\s+)image: (.*)$", "$1image: $2\n$1imagePullPolicyy: Always");
      await editYaml(page, "^  replicas: (.*)$", "  replicas: $1\n  re");
      await cursorAt(page, "^  re$", "end");
      await wait(1500);
      await editorTrigger(page, "editor.action.triggerSuggest");
      await wait(1500);
    },
  },
  "editor-hover": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await cursorAt(page, "^  strategy:", 3);
      await editorTrigger(page, "editor.action.showHover");
      await wait(1500);
    },
  },
  review: {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await editYaml(page, "^  replicas: (.*)$", "  replicas: 6");
      await editYaml(page, "^(\\s+)image: (.*):v2.14.3$", "$1image: $2:v2.15.0");
      await page.keyboard.press("Control+s");
      await page.waitForFunction(() => /passed/.test(document.querySelector("[data-testid=dry-run-status]")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
      await wait(1000);
    },
  },
  "review-errors": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await editYaml(page, "^  replicas: (.*)$", "  replicas: -1");
      await editYaml(page, "^(\\s+)image: (.*)$", "$1image: $2\n$1imagePullPolicyy: Always");
      await page.keyboard.press("Control+s");
      await page.waitForSelector("[data-testid=problems]", { timeout: 15000 }).catch(() => {});
      await editYaml(page, "^(\\s+)imagePullPolicyy: Always\n", "");
      await page.keyboard.press("Control+s");
      await page.waitForFunction(() => /Rejected/.test(document.querySelector("[data-testid=dry-run-status]")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
      await wait(1000);
    },
  },
  "review-strict": {
    url: "/deployments?resource=deployments&kind=Deployment",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await editYaml(page, "^(\\s+)image: (.*)$", "$1image: $2\n$1imagePullPolicyy: Always");
      await page.keyboard.press("Control+s");
      await page.waitForSelector("[data-testid=problems]", { timeout: 15000 }).catch(() => {});
      await wait(1000);
    },
  },
  "review-conflict": {
    url: "/deployments?resource=deployments&kind=Deployment&scenario=conflict",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await editYaml(page, "^  replicas: (.*)$", "  replicas: 6");
      await page.keyboard.press("Control+s");
      await page.waitForSelector("[data-testid=conflict]", { timeout: 15000 }).catch(() => {});
      await wait(1000);
    },
  },
  "describe-search": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Describe");
      await page.waitForSelector("[data-testid=describe-output]", { timeout: 10000 }).catch(() => {});
      await page.keyboard.press("Control+f");
      await page.keyboard.type("ready");
      await page.keyboard.press("Enter");
      await wait(800);
    },
  },
  "describe-yaml": {
    url: "/pods",
    ready: "tbody tr td",
    run: async (page) => {
      await openRowAction(page, "payments-api", "Describe");
      await page.waitForSelector("[data-testid=describe-output]", { timeout: 10000 }).catch(() => {});
      await page.getByRole("button", { name: "YAML", exact: true }).click();
      await page.waitForSelector(".monaco-editor", { timeout: 20000 }).catch(() => {});
      await wait(1500);
    },
  },
  compare: {
    url: "/deployments?resource=deployments&kind=Deployment&scenario=compare",
    ready: "tbody tr td",
    run: async (page) => {
      await openEditor(page);
      await page.getByRole("button", { name: /Compare/ }).click();
      await wait(400);
      await page.locator('[role="menuitem"]', { hasText: "staging-us-east-2" }).first().click();
      await page.waitForSelector(".monaco-diff-editor", { timeout: 20000 }).catch(() => {});
      await wait(2000);
    },
  },
};

/* Editor helpers: drive Monaco through window.monaco (harness globalAPI). */
async function openEditor(page, rowText = "payments-api") {
  await openRowAction(page, rowText, "Edit");
  await page.waitForSelector(".monaco-editor", { timeout: 20000 }).catch(() => {});
  await page
    .waitForFunction(() => /·/.test(document.querySelector("[data-testid=schema-status]")?.textContent || ""), null, { timeout: 20000 })
    .catch(() => console.error("schema did not load"));
  await wait(800);
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

async function cursorAt(page, search, column) {
  await page.evaluate(
    ({ search, column }) => {
      const model = monaco.editor.getModels().find((m) => m.uri.authority === "jet-pilot");
      const [match] = model.findMatches(search, false, true, true, null, false);
      const line = match.range.startLineNumber;
      const editor = monaco.editor.getEditors().find((e) => e.getModel() === model && e.getContainerDomNode().offsetParent);
      editor.setPosition({ lineNumber: line, column: column === "end" ? model.getLineMaxColumn(line) : column });
      editor.revealLineInCenter(line);
      editor.focus();
    },
    { search, column }
  );
}

async function editorTrigger(page, action) {
  await page.evaluate((action) => {
    const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus());
    editor?.trigger("shoot", action, {});
  }, action);
}

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
      const os = new URL(BASE + screen.url).searchParams.get("os") || "linux";
      await page.goto(`${BASE}${screen.url}${sep}theme=${theme}&scenario=${scenario}&os=${os}`);
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
