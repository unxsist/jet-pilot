/*
 * JET Pilot product demo: records the UI harness frame by frame and encodes
 * the marketing videos (MP4 master + 1080, README WebP/GIF, poster).
 *
 *   npm run harness                     # in another terminal
 *   node dev/harness/demo-video.mjs
 *
 * The README shows docs/media/demo.webp: copy $OUT_DIR/demo-readme.webp
 * there after re-recording.
 *
 * Env:
 *   HARNESS_URL  default http://localhost:5174 (Vite binds localhost / ::1)
 *   THEMES       default "dark,light" (each gets an MP4 + poster; dark also the
 *                1080 MP4 and the README WebP/GIF)
 *   DSF          device scale factor, default 2 (1440x900 window -> 2880x1800)
 *   CAPTIONS     1 (default) shows a caption pill per scene, 0 hides them
 *   SCENES       comma list to record only some scenes (drafts), e.g. "hub,logs"
 *   OUT_DIR      default ~/.cache/jet-pilot/demo
 *   WORK_DIR     scratch frames, default ~/.cache/jp-demo/work (deleted at the
 *                end unless KEEP=1)
 *   PLAYWRIGHT_CORE / CHROMIUM   default /tmp/pw/node_modules/playwright-core, /usr/bin/chromium
 *
 * How it works: every scene runs in its own browser context against the
 * harness (mocked Tauri IPC + fixtures). Playwright's fake clock is paused
 * while recording and advanced by exactly one frame's worth of time before
 * each screenshot, so the app's timers (log streaming, watch deltas, graph
 * transitions) run in video time no matter how slow the capture is. CSS
 * animations are left to finish (reduced motion) before every shot, and
 * anything that pops in (palette, menus, dialogs, scene changes) gets a
 * crossfade blended by ffmpeg. The mouse pointer is a drawn arrow that
 * glides on eased, slightly curved paths.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, statSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "/tmp/pw/node_modules/playwright-core");

const BASE = process.env.HARNESS_URL || "http://localhost:5174";
const THEMES = (process.env.THEMES || "dark,light").split(",").filter(Boolean);
const DSF = Number(process.env.DSF || 2);
const CAPTIONS = process.env.CAPTIONS !== "0";
const ONLY = (process.env.SCENES || "").split(",").filter(Boolean);
const OUT = process.env.OUT_DIR || `${homedir()}/.cache/jet-pilot/demo`;
const WORK = process.env.WORK_DIR || `${homedir()}/.cache/jp-demo/work`;
const FPS = 30;
const W = 1440;
const H = 900;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });

/* Deterministic jitter for typing. */
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/* ------------------------------------------------------------ overlays -- */

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="28" viewBox="0 0 22 28"><path d="M2 1.5 L2 22.5 L7.2 17.6 L10.6 25.6 L14.2 24.1 L10.9 16.3 L18 16.3 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

/* Pointer, traffic lights, caption pill; transitions off for the overlays only. */
async function installOverlays(page, theme) {
  await page.evaluate(
    ({ svg, theme }) => {
      const style = document.createElement("style");
      style.textContent = `
        *, *::before, *::after { caret-color: transparent !important; }
        .monaco-editor .cursors-layer .cursor { visibility: hidden !important; }
        #demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
          filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); transform-origin: 2px 1.5px; }
        #demo-caption { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); z-index: 2147483646;
          pointer-events: none; font: 500 15px/1.2 "Inter Variable", Inter, system-ui, sans-serif; letter-spacing: -0.005em;
          padding: 10px 18px; border-radius: 999px; white-space: nowrap; display: none;
          backdrop-filter: blur(14px) saturate(1.2); -webkit-backdrop-filter: blur(14px) saturate(1.2); }
        #demo-caption.dark { background: rgba(24,24,27,.82); color: #fafafa; box-shadow: 0 0 0 1px rgba(255,255,255,.09), 0 8px 30px rgba(0,0,0,.45); }
        #demo-caption.light { background: rgba(255,255,255,.88); color: #18181b; box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 8px 30px rgba(0,0,0,.14); }
        #demo-card { position: fixed; inset: 0; z-index: 2147483645; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 0; font-family: "Inter Variable", Inter, system-ui, sans-serif; }
        #demo-card img { width: 112px; height: 112px; margin-bottom: 26px; }
        #demo-card h1 { margin: 0; font-size: 46px; line-height: 1.1; font-weight: 650; letter-spacing: -0.025em; }
        #demo-card p { margin: 16px 0 0; font-size: 19px; font-weight: 450; opacity: .62; letter-spacing: -0.005em; }
        #demo-card .url { margin-top: 30px; font-size: 17px; font-weight: 550; opacity: .9; }
      `;
      document.head.appendChild(style);
      const cursor = document.createElement("div");
      cursor.id = "demo-cursor";
      cursor.innerHTML = svg;
      cursor.style.display = "none";
      document.body.appendChild(cursor);
      const caption = document.createElement("div");
      caption.id = "demo-caption";
      caption.className = theme;
      document.body.appendChild(caption);
      const lights = document.createElement("div");
      lights.style.cssText = "position:fixed;left:15.6px;top:15.6px;display:flex;gap:7.8px;z-index:2147483644;pointer-events:none";
      for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
        const dot = document.createElement("span");
        dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.18)`;
        lights.appendChild(dot);
      }
      document.body.appendChild(lights);
    },
    { svg: CURSOR_SVG, theme }
  );
}

/* --------------------------------------------------------------- recorder -- */

class Recorder {
  constructor(page, dir, theme) {
    this.page = page;
    this.dir = dir;
    this.theme = theme;
    this.frames = []; // { file, frames, fade }
    this.n = 0;
    this.pos = { x: W * 0.62, y: H * 0.74 };
    this.fadeNext = 0;
    this.vtime = 0; // virtual ms elapsed
    this.vticks = 0; // virtual ms handed to the clock
  }

  /* Pause the page clock: from here on, time only moves in step(). */
  async start() {
    const now = await this.page.evaluate(() => Date.now());
    await this.page.clock.pauseAt(now + 50);
  }

  /* Moves the page clock by ms without recording (loading in a cut). */
  async advance(ms) {
    await this.page.clock.runFor(ms);
  }

  /* Waits (in virtual + real time) until fn() is truthy, unrecorded. */
  async until(fn, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await fn().catch(() => false)) return true;
      await this.advance(50);
      await wait(40);
    }
    log("until: timed out");
    return false;
  }

  /* No finite CSS animation/transition running (spinners are ignored). */
  async quiet() {
    for (let i = 0; i < 30; i++) {
      const busy = await this.page.evaluate(
        () =>
          document.getAnimations().filter((a) => {
            if (a.playState !== "running") return false;
            const t = a.effect?.getComputedTiming?.();
            return t && t.iterations !== Infinity && t.endTime !== Infinity;
          }).length
      );
      if (!busy) return;
      await wait(40);
    }
  }

  /* Advance the clock by ms (rounded to frames), screenshot, show it for that long. */
  async step(ms, fade = 0) {
    const frames = Math.max(1, Math.round((ms * FPS) / 1000));
    this.vtime += (frames * 1000) / FPS;
    const delta = Math.round(this.vtime - this.vticks);
    if (delta > 0) await this.page.clock.runFor(delta);
    this.vticks += delta;
    await wait(15);
    await this.quiet();
    const file = `${this.dir}/${String(this.n++).padStart(5, "0")}.png`;
    await this.page.screenshot({ path: file, timeout: 60000 });
    this.frames.push({ file, frames, fade: fade || this.fadeNext });
    this.fadeNext = 0;
  }

  /* Holds the current view, re-shooting every `every` ms so live data moves. */
  async hold(ms, every = 200) {
    let left = ms;
    while (left > 1) {
      const d = Math.min(every, left);
      await this.step(d);
      left -= d;
    }
  }

  async showCursor(on = true) {
    await this.page.evaluate(
      ({ on, x, y }) => {
        const c = document.getElementById("demo-cursor");
        c.style.display = on ? "block" : "none";
        c.style.transform = `translate(${x - 2}px, ${y - 1.5}px)`;
      },
      { on, ...this.pos }
    );
    if (on) await this.page.mouse.move(this.pos.x, this.pos.y);
  }

  async placeCursor(x, y, scale = 1) {
    this.pos = { x, y };
    await this.page.evaluate(
      ({ x, y, scale }) => {
        document.getElementById("demo-cursor").style.transform = `translate(${x - 2}px, ${y - 1.5}px) scale(${scale})`;
      },
      { x, y, scale }
    );
    await this.page.mouse.move(x, y);
  }

  /* Eased glide with a gentle arc. */
  async glide(x, y, ms = 850) {
    const from = { ...this.pos };
    const n = Math.max(2, Math.round((ms * FPS) / 1000));
    const dx = x - from.x;
    const dy = y - from.y;
    const dist = Math.hypot(dx, dy);
    const arc = Math.min(40, dist * 0.08);
    const nx = dist ? -dy / dist : 0;
    const ny = dist ? dx / dist : 0;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const bow = Math.sin(Math.PI * e) * arc;
      await this.placeCursor(from.x + dx * e + nx * bow, from.y + dy * e + ny * bow);
      await this.step(1000 / FPS);
    }
  }

  async glideTo(locator, ms, { dx = 0, dy = 0, ax = 0.5, ay = 0.5 } = {}) {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`no box for ${locator}`);
    await this.glide(box.x + box.width * ax + dx, box.y + box.height * ay + dy, ms);
  }

  /* Press + release with a small pointer squeeze; `fade` crossfades the result. */
  async click({ button = "left", fade = 0, settle = 250 } = {}) {
    const { x, y } = this.pos;
    await this.placeCursor(x, y, 0.86);
    await this.page.mouse.down({ button });
    await this.step(1000 / FPS);
    await this.step(1000 / FPS);
    await this.page.mouse.up({ button });
    await this.placeCursor(x, y, 1);
    // Let the UI react (menus/dialogs mount) before the crossfade target.
    await this.advance(settle);
    await wait(settle);
    this.fadeNext = fade;
  }

  async press(key, { fade = 0, settle = 250 } = {}) {
    await this.page.keyboard.press(key);
    await this.advance(settle);
    await wait(settle);
    this.fadeNext = fade;
  }

  /* Types with a human rhythm; spaces and word starts are a touch slower. */
  async type(text, { min = 85, max = 165 } = {}) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      const d = min + rand() * (max - min) + (ch === " " || ch === "-" ? 40 : 0);
      await this.step(d);
    }
  }

  async caption(text, fade = 0) {
    if (!CAPTIONS) return;
    await this.page.evaluate((text) => {
      const c = document.getElementById("demo-caption");
      c.textContent = text || "";
      c.style.display = text ? "block" : "none";
    }, text);
    if (fade) this.fadeNext = fade;
  }

  /* The current view without caption and pointer, for the poster image. */
  async poster(file) {
    await this.page.evaluate(() => {
      for (const id of ["demo-cursor", "demo-caption"]) {
        const el = document.getElementById(id);
        el.dataset.display = el.style.display;
        el.style.display = "none";
      }
    });
    await this.page.screenshot({ path: file });
    await this.page.evaluate(() => {
      for (const id of ["demo-cursor", "demo-caption"]) {
        const el = document.getElementById(id);
        el.style.display = el.dataset.display;
      }
    });
  }

  /* A full-window title card over the app (intro / outro). */
  async card(html) {
    await this.page.evaluate(
      ({ html }) => {
        let card = document.getElementById("demo-card");
        if (!html) return card?.remove();
        if (!card) {
          card = document.createElement("div");
          card.id = "demo-card";
          document.body.appendChild(card);
        }
        // The app's own surface (the body itself is transparent in light mode).
        card.style.display = "none";
        let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        while (el && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(el).backgroundColor)) el = el.parentElement;
        const surface = getComputedStyle(el || document.documentElement);
        card.style.display = "";
        card.style.background = surface.backgroundColor;
        card.style.color = surface.color;
        card.innerHTML = html;
      },
      { html }
    );
    await this.page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  }
}

/* ----------------------------------------------------------------- setup -- */

async function pickNamespaces(page, context, namespaces) {
  await page.locator('[aria-haspopup="menu"]').first().click();
  await wait(400);
  for (const ns of namespaces) {
    await page.locator('[role="menuitem"]', { hasText: context }).first().hover();
    await wait(400);
    await page
      .locator('[role="menu"]')
      .last()
      .locator('[role="menuitemcheckbox"], [role="menuitem"]', { hasText: new RegExp(`^\\s*${ns}\\s*$`) })
      .first()
      .click();
    await wait(400);
  }
  await page.keyboard.press("Escape");
  await wait(400);
}

async function panelTopAt(page, y) {
  const handle = page.locator("[data-panel-resize-handle-id]").first();
  const box = await handle.boundingBox().catch(() => null);
  if (!box) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, y, { steps: 8 });
  await page.mouse.up();
  await wait(300);
}

async function openRowAction(page, rowText, action, sub) {
  await page.locator("tbody tr", { hasText: rowText }).first().click({ button: "right" });
  await wait(300);
  const item = page.locator('[role="menuitem"]', { hasText: new RegExp(`^\\s*${action}\\b`) }).first();
  if (sub) {
    await item.hover();
    await wait(300);
    await page.locator('[role="menuitem"]', { hasText: sub }).first().click();
  } else {
    await item.click();
  }
  await wait(500);
}

async function setPodState(page, name, state) {
  await page.evaluate(
    ({ name, state }) =>
      window.__harnessMutate("pods", name, (p) => {
        const running = state === "running";
        p.status.phase = running ? "Running" : "Pending";
        p.status.containerStatuses = (p.status.containerStatuses || []).map((c) => ({
          ...c,
          ready: running,
          started: running,
          state: running ? { running: { startedAt: new Date().toISOString() } } : { waiting: { reason: state } },
        }));
        return p;
      }),
    { name, state }
  );
}

/* ---------------------------------------------------------------- scenes -- */

const DEPLOYMENTS = "/deployments?resource=deployments&kind=Deployment";
const LOGO = "/src/assets/logo.png";

const scenes = [
  {
    name: "hub",
    url: "/clusters?scenario=hub",
    ready: "[role=grid]",
    settle: 3500,
    async run(rec, page) {
      // Intro card over the hub, then the hub fades in.
      await rec.card(`<img src="${LOGO}" alt=""><h1>JET Pilot</h1><p>The Kubernetes desktop client</p>`);
      await rec.hold(2000, 2000);
      await rec.card(null);
      await rec.caption("Every cluster and cloud account in one place");
      rec.pos = { x: 1160, y: 610 };
      await rec.showCursor();
      rec.fadeNext = 600;
      await rec.hold(900, 300);
      await rec.glideTo(page.getByText("Checkout", { exact: true }).first(), 1000, { dx: 40 });
      await rec.hold(300);
      await rec.click({ fade: 200 });
      await rec.hold(1200, 300);
      // Glance down the list: AKS, EKS, GKE, Scaleway, local.
      await rec.glideTo(page.getByText("Sandbox", { exact: true }).first(), 1100, { dx: 30 });
      await rec.hold(800, 400);
    },
  },
  {
    name: "pods",
    url: "/pods?contexts=2",
    ready: "tbody tr td",
    async setup(page) {
      await pickNamespaces(page, "staging-us-east-2", ["payments", "checkout"]);
      await pickNamespaces(page, "prod-eu-west-1", ["payments", "checkout"]);
      await page.locator("thead th", { hasText: /^\s*Name\s*$/ }).first().click();
      await wait(600);
    },
    async run(rec, page) {
      await rec.caption("Pods across clusters, live");
      await rec.showCursor();
      await rec.hold(800, 400);
      const creating = page.locator("tbody tr", { hasText: "image-resizer-khjm9jqhm-xnh6c" }).first();
      await rec.glideTo(creating.locator("td").nth(1), 950);
      await rec.hold(500, 100);
      await setPodState(page, "image-resizer-khjm9jqhm-xnh6c", "running");
      await rec.hold(1000, 100);
      await setPodState(page, "image-resizer-khjm9jqhm-dnpr5", "ContainerCreating");
      await rec.hold(1000, 200);
      // Command palette: jump to the resource graph. The pointer hides
      // while typing, like on macOS.
      await rec.showCursor(false);
      await rec.press("Meta+k", { fade: 180 });
      await rec.caption("Jump anywhere with ⌘K", 180);
      await rec.hold(600, 300);
      await rec.type("graph");
      await rec.hold(550, 275);
      await rec.page.keyboard.press("Enter");
      await rec.until(() => page.locator(".vue-flow__node-k8s").first().isVisible());
      await rec.advance(1500);
      await wait(1200);
      await rec.caption("See how everything connects");
      rec.fadeNext = 300;
      await rec.hold(900, 300);
      await rec.poster(`${rec.dir}/../poster.png`);
      const node = page
        .locator(".vue-flow__node-k8s")
        .filter({ hasText: "checkout-api" })
        .filter({ has: page.locator(".graph-card__meta", { hasText: "Deployment" }) })
        .first();
      await rec.showCursor(true);
      await rec.glideTo(node, 1000);
      await rec.hold(250);
      // The graph pans to the selection (350 ms): shoot it frame by frame.
      await rec.click({ fade: 130, settle: 10 });
      await rec.hold(700, 1000 / 30);
      await rec.glide(1250, 420, 850);
      await rec.hold(1100, 275);
    },
  },
  {
    name: "logs",
    url: DEPLOYMENTS,
    ready: "tbody tr td",
    async setup(page) {
      await openRowAction(page, "payments-api", "Logs", "All pods");
      await panelTopAt(page, 164);
      await wait(2500);
    },
    async run(rec, page) {
      await rec.caption("Logs with JSON fields you can filter");
      await rec.showCursor();
      await rec.hold(700, 100);
      await rec.glideTo(page.getByRole("button", { name: "Level" }), 950, { ax: 0.25 });
      await rec.hold(200, 100);
      await rec.click({ fade: 150 });
      await rec.hold(600, 100);
      await rec.glideTo(page.locator(`[aria-label='Filter level "error"']`), 700);
      await rec.hold(200, 100);
      await rec.click({ fade: 200 });
      await rec.hold(800, 100);
      await rec.glideTo(page.locator(`[aria-label='Filter level "warn"']`), 550);
      await rec.hold(150, 75);
      await rec.click({ fade: 200 });
      await rec.hold(1300, 100);
    },
  },
  {
    name: "guardrail",
    url: `${DEPLOYMENTS}&scenario=hub`,
    ready: "tbody tr td",
    async run(rec, page) {
      await rec.caption("Guardrails for production");
      rec.pos = { x: 700, y: 250 };
      await rec.showCursor();
      await rec.hold(800, 400);
      const row = page.locator("tbody tr", { hasText: "payments-api" }).first();
      await rec.glideTo(row.locator("td").nth(2), 850, { ax: 0.3 });
      await rec.hold(250);
      await rec.click({ button: "right", fade: 140 });
      await rec.hold(300);
      await rec.glideTo(page.locator('[role="menuitem"]', { hasText: /Delete/ }).first(), 600, { ax: 0.3 });
      await rec.hold(250);
      await rec.click({ fade: 220, settle: 500 });
      await rec.showCursor(false);
      await rec.hold(700, 350);
      await rec.type("payments-api", { min: 70, max: 130 });
      await rec.hold(400, 200);
      await rec.showCursor(true);
      await rec.glideTo(page.getByRole("alertdialog").getByRole("button", { name: "Delete" }), 750);
      await rec.hold(1200, 300);
      // Outro card.
      await rec.showCursor(false);
      await rec.caption(null);
      await rec.card(
        `<img src="${LOGO}" alt=""><h1>JET Pilot</h1><p>Free and open source · macOS, Windows and Linux</p><div class="url">jet-pilot.app</div>`
      );
      rec.fadeNext = 600;
      await rec.hold(2800, 2800);
    },
  },
];

/* --------------------------------------------------------------- record -- */

async function recordScene(browser, scene, theme, dir) {
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: DSF,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.clock.install();
  const page = await context.newPage();
  page.on("pageerror", (e) => log(`[${scene.name}/${theme}] pageerror`, e.message));
  const url = new URL(BASE + scene.url);
  if (!url.searchParams.get("scenario")) url.searchParams.set("scenario", "default");
  url.searchParams.set("theme", theme);
  url.searchParams.set("os", "macos");
  await page.goto(url.toString());
  await page.waitForSelector(scene.ready, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await wait(scene.settle ?? 1500);
  await page.mouse.move(W - 5, H - 5);
  if (scene.setup) await scene.setup(page);
  await page.mouse.move(W - 5, H - 5);
  await installOverlays(page, theme);
  await wait(400);
  const rec = new Recorder(page, dir, theme);
  await rec.start();
  await scene.run(rec, page);
  await context.close();
  log(`[${scene.name}/${theme}] ${rec.frames.length} shots, ${(rec.vtime / 1000).toFixed(1)} s`);
  return rec.frames;
}

/* -------------------------------------------------------------- assemble -- */

/* k blended frames between a and b (smoothstep), as PNG files. */
function blend(a, b, k, prefix) {
  const files = [];
  for (let i = 1; i <= k; i++) {
    const t = i / (k + 1);
    const e = t * t * (3 - 2 * t);
    const out = `${prefix}-${i}.png`;
    ff([
      "-i", a, "-i", b,
      "-filter_complex", `[0]format=gbrp[a];[1]format=gbrp[b];[b][a]blend=all_expr='A*${e.toFixed(4)}+B*${(1 - e).toFixed(4)}',format=rgb24`,
      "-frames:v", "1", out,
    ]);
    files.push(out);
  }
  return files;
}

function assemble(frames, dir) {
  const list = [];
  let prev = null;
  let fadeId = 0;
  let debt = 0; // fade frames still to take out of the following frames
  for (const f of frames) {
    if (f.fade && prev) {
      const k = Math.max(1, Math.round((f.fade * FPS) / 1000));
      for (const file of blend(prev.file, f.file, k, `${dir}/fade${String(fadeId++).padStart(3, "0")}`)) {
        list.push({ file, frames: 1 });
      }
      debt += k;
    }
    const pay = Math.min(debt, f.frames - 1);
    debt -= pay;
    list.push({ ...f, frames: f.frames - pay });
    prev = f;
  }
  const total = list.reduce((s, f) => s + f.frames, 0);
  const write = (name, entries) => {
    const lines = ["ffconcat version 1.0"];
    for (const f of entries) lines.push(`file '${f.file}'`, `duration ${(f.frames / FPS).toFixed(6)}`);
    lines.push(`file '${entries.at(-1).file}'`);
    writeFileSync(`${dir}/${name}`, lines.join("\n") + "\n");
    return `${dir}/${name}`;
  };
  // Hard cuts for the GIF: every crossfade frame is a full-frame change,
  // which GIF pays for dearly. Their time goes to the next frame.
  const cuts = [];
  let carry = 0;
  for (const f of list) {
    if (f.file.includes("/fade")) carry += f.frames;
    else {
      cuts.push({ ...f, frames: f.frames + carry });
      carry = 0;
    }
  }
  return { concat: write("frames.ffconcat", list), cuts: write("cuts.ffconcat", cuts), seconds: total / FPS };
}

function encode({ concat, cuts, seconds }, theme) {
  const input = (list) => ["-f", "concat", "-safe", "0", "-i", list, "-t", seconds.toFixed(3)];
  const master = `${OUT}/demo-${theme}.mp4`;
  const x264 = ["-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"];
  log(`encode ${master}`);
  ff([...input(concat), "-vf", `fps=${FPS},format=yuv420p`, "-r", String(FPS), ...x264, "-crf", "17", master]);
  if (theme !== "dark") return [master];
  const outs = [master];
  const hd = `${OUT}/demo-dark-1080.mp4`;
  ff([...input(concat), "-vf", `fps=${FPS},scale=1920:-2:flags=lanczos,format=yuv420p`, "-r", String(FPS), ...x264, "-crf", "18", hd]);
  outs.push(hd);
  // README: animated WebP (better) and GIF, both 1280 px wide.
  const webp = `${OUT}/demo-readme.webp`;
  ff([...input(concat), "-vf", "fps=15,scale=1280:-2:flags=lanczos", "-c:v", "libwebp_anim", "-lossless", "0", "-quality", "82", "-compression_level", "6", "-preset", "text", "-loop", "0", "-an", webp]);
  outs.push(webp);
  const gif = `${OUT}/demo-readme.gif`;
  ff([
    ...input(cuts),
    "-filter_complex", "fps=15,scale=1280:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
    "-loop", "0", gif,
  ]);
  outs.push(gif);
  return outs;
}

/* ------------------------------------------------------------------ main -- */

mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--font-render-hinting=none", "--disable-gpu"],
  ignoreDefaultArgs: ["--disable-dev-shm-usage"],
});

const produced = [];
for (const theme of THEMES) {
  const frames = [];
  for (const scene of scenes) {
    if (ONLY.length && !ONLY.includes(scene.name)) continue;
    const shots = await recordScene(browser, scene, theme, `${WORK}/${theme}/${scene.name}`);
    if (frames.length) shots[0].fade = shots[0].fade || 450; // scene change
    frames.push(...shots);
  }
  const assembled = assemble(frames, `${WORK}/${theme}`);
  log(`[${theme}] ${assembled.seconds.toFixed(1)} s`);
  produced.push(...encode(assembled, theme));
  try {
    copyFileSync(`${WORK}/${theme}/poster.png`, `${OUT}/poster-${theme}.png`);
    produced.push(`${OUT}/poster-${theme}.png`);
  } catch {}
}
await browser.close();

for (const f of produced) log(f, `${(statSync(f).size / 1e6).toFixed(2)} MB`);
if (!process.env.KEEP) rmSync(WORK, { recursive: true, force: true });
