#!/usr/bin/env node
/*
 * Generates the lazy-loaded built-in themes (src/lib/themes/builtin/themes/
 * *.json + manifest.json):
 *
 *   - curated VS Code themes (MIT), from the repository at a pinned commit
 *     or, for themes that are only built at release time, from the
 *     published .vsix on Open VSX at a pinned version
 *   - the built-in palettes (Blossom, Grove, Ocean, Ember, Iris): complete
 *     theme files kept in the output folder as they are (PALETTES)
 *
 * VS Code themes go through the app's own importer (src/lib/themes/import)
 * and light / dark files are merged into one theme with a variant. Every
 * downloaded source's licence is checked to be MIT before it is converted;
 * licences and attributions are listed in THIRD_PARTY_THEMES.md.
 *
 *   node scripts/convert-themes.mjs [--refresh]
 *
 * Downloads are cached in $TMPDIR/jet-pilot-theme-sources (--refresh
 * re-downloads). The output is deterministic for the pinned refs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { tsImport } from "tsx/esm/api";

const root = resolve(new URL("..", import.meta.url).pathname);
const outDir = join(root, "src/lib/themes/builtin/themes");
const manifestPath = join(root, "src/lib/themes/builtin/manifest.json");
const cacheDir = join(tmpdir(), "jet-pilot-theme-sources");
const refresh = process.argv.includes("--refresh");

/** Built-in palettes kept as complete theme files (provenance: THIRD_PARTY_THEMES.md). */
const PALETTES = ["blossom", "grove", "ocean", "ember", "iris"];

const raw = (repo, ref, path) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
const vsix = (namespace, name, version) =>
  `https://open-vsx.org/api/${namespace}/${name}/${version}/file/${namespace}.${name}-${version}.vsix`;

/**
 * Curated themes. `light` / `dark` name the upstream files; `source` is a
 * repository at a pinned commit (`repo` + `ref`) or an Open VSX package.
 */
const CURATED = [
  {
    id: "catppuccin",
    name: "Catppuccin",
    url: "https://github.com/catppuccin/vscode",
    source: { vsix: vsix("Catppuccin", "catppuccin-vsc", "3.19.0") },
    light: "extension/themes/latte.json",
    dark: "extension/themes/mocha.json",
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    url: "https://github.com/tokyo-night/tokyo-night-vscode-theme",
    source: { repo: "tokyo-night/tokyo-night-vscode-theme", ref: "7c0f11eaef322f293621ca7befe462214b7ea468" },
    light: "themes/tokyo-night-light-color-theme.json",
    dark: "themes/tokyo-night-color-theme.json",
  },
  {
    id: "dracula",
    name: "Dracula",
    url: "https://github.com/dracula/visual-studio-code",
    source: { vsix: vsix("dracula-theme", "theme-dracula", "2.25.1") },
    dark: "extension/theme/dracula.json",
  },
  {
    id: "nord",
    name: "Nord",
    url: "https://github.com/nordtheme/visual-studio-code",
    source: { repo: "nordtheme/visual-studio-code", ref: "69b80f5196b8c3feb6df7f67e4225adb3040e3fb" },
    dark: "themes/nord-color-theme.json",
  },
  {
    id: "github",
    name: "GitHub",
    url: "https://github.com/primer/github-vscode-theme",
    source: { vsix: vsix("GitHub", "github-vscode-theme", "6.3.5") },
    light: "extension/themes/light-default.json",
    dark: "extension/themes/dark-default.json",
  },
  {
    id: "one-dark-pro",
    name: "One Dark Pro",
    url: "https://github.com/Binaryify/OneDark-Pro",
    source: { repo: "Binaryify/OneDark-Pro", ref: "36088915dd40c34fce2780065e1eca0f3ec91e8b" },
    dark: "themes/OneDark-Pro.json",
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    url: "https://github.com/rose-pine/vscode",
    source: { repo: "rose-pine/vscode", ref: "6b51224aa5936d3fc18e270ab35cde0a71fecf29" },
    light: "themes/rose-pine-dawn-color-theme.json",
    dark: "themes/rose-pine-color-theme.json",
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    url: "https://github.com/jdinhify/vscode-theme-gruvbox",
    source: { vsix: vsix("jdinhlife", "gruvbox", "1.29.1") },
    light: "extension/themes/gruvbox-light-medium.json",
    dark: "extension/themes/gruvbox-dark-medium.json",
  },
];

/* ---- downloads ---- */

async function download(url) {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, createHash("sha256").update(url).digest("hex").slice(0, 16));
  if (!refresh && existsSync(file)) return readFileSync(file);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(file, bytes);
  return bytes;
}

/** Minimal zip reader (central directory + stored / deflated entries). */
function readZip(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("Not a zip file.");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, size, local });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return (name) => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`${name} is not in the package.`);
    const start =
      entry.local + 30 + bytes.readUInt16LE(entry.local + 26) + bytes.readUInt16LE(entry.local + 28);
    const data = bytes.subarray(start, start + entry.size);
    return (entry.method === 0 ? data : inflateRawSync(data)).toString("utf8");
  };
}

const isMit = (text) => /\bMIT License\b/i.test(text) || /Permission is hereby granted, free of charge/.test(text);

/** The licence text of a repository at `ref` (whatever the file is called). */
async function repoLicense(repo, ref) {
  for (const name of ["LICENSE", "LICENSE.txt", "LICENSE.md", "license", "license.md"]) {
    try {
      return (await download(raw(repo, ref, name))).toString("utf8");
    } catch {
      // try the next name
    }
  }
  return "";
}

/** A reader for the theme's files, after checking the licence is MIT. */
async function openSource(theme) {
  if (theme.source.vsix) {
    const read = readZip(await download(theme.source.vsix));
    const manifest = JSON.parse(read("extension/package.json"));
    const license = (() => {
      for (const name of ["extension/LICENSE.txt", "extension/LICENSE", "extension/LICENSE.md"]) {
        try {
          return read(name);
        } catch {
          // try the next name
        }
      }
      return "";
    })();
    if (manifest.license !== "MIT" || !isMit(license)) {
      throw new Error(`${theme.name}: the package is not MIT licensed.`);
    }
    const uiThemes = Object.fromEntries(
      (manifest.contributes?.themes ?? []).map((entry) => [
        `extension/${entry.path.replace(/^\.\//, "")}`,
        entry.uiTheme,
      ])
    );
    return {
      ref: theme.source.vsix.match(/\/(\d[^/]*)\/file\//)[1],
      read: async (path) => ({ text: read(path), uiTheme: uiThemes[path] }),
    };
  }
  const { repo, ref } = theme.source;
  const license = await repoLicense(repo, ref);
  if (!isMit(license)) throw new Error(`${theme.name}: the repository is not MIT licensed.`);
  const manifest = JSON.parse((await download(raw(repo, ref, "package.json"))).toString("utf8"));
  const uiThemes = Object.fromEntries(
    (manifest.contributes?.themes ?? []).map((entry) => [entry.path.replace(/^\.\//, ""), entry.uiTheme])
  );
  return {
    ref: ref.slice(0, 12),
    read: async (path) => ({
      text: (await download(raw(repo, ref, path))).toString("utf8"),
      uiTheme: uiThemes[path],
    }),
  };
}

/* ---- conversion ---- */

const lib = (path) => tsImport(join(root, "src/lib/themes", path), import.meta.url);
const { importTheme } = await lib("import/index.ts");
const { mergeVariants } = await lib("import/vscode.ts");
const { parseThemeFile } = await lib("validate.ts");
const { resolveTheme } = await lib("resolve.ts");
const { themeAppearances } = await lib("runtime.ts");

async function convertCurated(theme) {
  const source = await openSource(theme);
  const load = async (path) => {
    const { text, uiTheme } = await source.read(path);
    const result = importTheme(text, path.split("/").pop(), { uiTheme });
    if (!result.ok) throw new Error(`${theme.name} (${path}): ${result.error}`);
    return result.themes[0];
  };
  const light = theme.light ? await load(theme.light) : null;
  const dark = theme.dark ? await load(theme.dark) : null;
  if (light && light.appearance !== "light") throw new Error(`${theme.light} is not a light theme.`);
  if (dark && dark.appearance !== "dark") throw new Error(`${theme.dark} is not a dark theme.`);
  const file =
    light && dark
      ? mergeVariants(light, dark, theme.name, theme.id)
      : { ...(light ?? dark), id: theme.id, name: theme.name };
  return {
    file,
    origin: { label: "VS Code", url: theme.url, license: "MIT" },
    ref: source.ref,
  };
}

/** The palettes as committed (read before the output folder is rewritten). */
function readPalettes() {
  return PALETTES.map((id) => {
    const file = JSON.parse(readFileSync(join(outDir, `${id}.json`), "utf8"));
    if (file.id !== id) throw new Error(`${id}.json: the id must be "${id}".`);
    return { file, origin: { label: "JET Pilot", license: "MIT" }, ref: "local" };
  });
}

const palettes = readPalettes();
const converted = [];
for (const theme of CURATED) converted.push(await convertCurated(theme));
converted.push(...palettes);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const manifest = [];
for (const { file, origin, ref } of converted) {
  // Built-ins must pass the same validation and resolve as user themes.
  parseThemeFile(file);
  for (const appearance of themeAppearances(file)) resolveTheme(file, appearance);
  writeFileSync(join(outDir, `${file.id}.json`), `${JSON.stringify(file)}\n`);
  manifest.push({ id: file.id, name: file.name, origin, appearances: themeAppearances(file) });
  console.log(`${file.id.padEnd(14)} ${themeAppearances(file).join("+").padEnd(10)} ${origin.label} @ ${ref}`);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${converted.length} themes to ${outDir.replace(`${root}/`, "")}`);
