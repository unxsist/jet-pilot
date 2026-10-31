#!/usr/bin/env node
/*
 * Refreshes the rule data the Health page's Upgrades tab ships with
 * (src/lib/upgrades/data/). Run it before a release; the app itself never
 * fetches any of this.
 *
 *   node scripts/update-upgrade-data.mjs [--pluto-ref <git ref>]
 *
 * - apis.json: deprecated and removed API versions, from Pluto's
 *   versions.yaml (FairwindsOps, Apache-2.0). Its licence is copied next
 *   to the data (LICENSE-pluto.txt) and named in the file's notice.
 * - platforms.json: support windows of Kubernetes minors on Amazon EKS,
 *   Google GKE, Azure AKS and upstream, from endoflife.date.
 * - addons.json: support of add-on minors (cert-manager, Argo CD, Flux,
 *   Karpenter, KEDA, Cilium, Calico, Istio, Kyverno), from endoflife.date.
 *
 * The output is sorted and stable, so a diff shows what really changed.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

const root = resolve(new URL("..", import.meta.url).pathname);
const outDir = join(root, "src/lib/upgrades/data");

const args = process.argv.slice(2);
const refIndex = args.indexOf("--pluto-ref");
const plutoRef = refIndex >= 0 && args[refIndex + 1] ? args[refIndex + 1] : "master";
const EOL = "https://endoflife.date/api/v1/products";

/* Our platform ids → endoflife.date products. */
const PLATFORMS = {
  eks: "amazon-eks",
  gke: "google-kubernetes-engine",
  aks: "azure-kubernetes-service",
  kubernetes: "kubernetes",
};

/* Add-ons endoflife.date covers (ingress-nginx, External Secrets and metrics-server it doesn't). */
const ADDONS = {
  "cert-manager": "cert-manager",
  "argo-cd": "argo-cd",
  flux: "flux",
  karpenter: "karpenter",
  keda: "keda",
  cilium: "cilium",
  calico: "calico",
  istio: "istio",
  kyverno: "kyverno",
};

async function get(url, accept) {
  const response = await fetch(url, {
    headers: { "User-Agent": "jet-pilot-update-upgrade-data", ...(accept ? { Accept: accept } : {}) },
  });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

const today = new Date().toISOString().slice(0, 10);

/* "v1.22.0" → "1.22"; empty → null. */
const minor = (version) => {
  const match = /^v?(\d+)\.(\d+)/.exec(String(version ?? ""));
  return match ? `${match[1]}.${match[2]}` : null;
};

const byVersion = (a, b) => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  return x[0] - y[0] || x[1] - y[1];
};

const write = (file, data) => {
  writeFileSync(join(outDir, file), typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote src/lib/upgrades/data/${file}`);
};

/* ----------------------------------------------------------- Pluto -- */

async function apis() {
  // The commit the ref points at, so the output names exactly what it was made from.
  const commit = (
    await get(`https://api.github.com/repos/FairwindsOps/pluto/commits/${plutoRef}`, "application/vnd.github.sha")
  ).trim();
  const raw = `https://raw.githubusercontent.com/FairwindsOps/pluto/${commit}`;
  const [source, licence] = await Promise.all([get(`${raw}/versions.yaml`), get(`${raw}/LICENSE`)]);
  const copyright = /Copyright \d{4}[^\n]*/.exec(licence)?.[0].trim() ?? "Copyright FairwindsOps Inc";
  const parsed = yaml.load(source);
  const seen = new Set();
  const list = [];
  for (const entry of parsed["deprecated-versions"] ?? []) {
    // "...List" kinds never appear in manifests or on objects.
    if (!entry.kind || /List$/.test(entry.kind)) continue;
    const key = `${entry.version}/${entry.kind}/${entry.component}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({
      apiVersion: entry.version,
      kind: entry.kind,
      deprecated: minor(entry["deprecated-in"]),
      removed: minor(entry["removed-in"]),
      replacement: entry["replacement-api"] || null,
      component: entry.component || "k8s",
    });
  }
  list.sort(
    (a, b) =>
      a.component.localeCompare(b.component) ||
      a.kind.localeCompare(b.kind) ||
      a.apiVersion.localeCompare(b.apiVersion)
  );
  write("LICENSE-pluto.txt", licence);
  write("apis.json", {
    source: `https://github.com/FairwindsOps/pluto/blob/${commit}/versions.yaml`,
    notice: `Generated from Pluto's versions.yaml. ${copyright}. Licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0); see LICENSE-pluto.txt.`,
    generated: today,
    apis: list,
  });
}

/* --------------------------------------------------- endoflife.date -- */

const date = (value) => (typeof value === "string" ? value : null);

async function product(id) {
  const { result } = JSON.parse(await get(`${EOL}/${id}`));
  return result;
}

async function platforms() {
  const out = {};
  for (const [key, id] of Object.entries(PLATFORMS)) {
    const result = await product(id);
    out[key] = {
      label: result.label,
      page: result.links?.html ?? `https://endoflife.date/${id}`,
      releases: result.releases
        .filter((r) => minor(r.name))
        .map((r) => ({
          cycle: minor(r.name),
          released: date(r.releaseDate),
          // Standard support (EKS, AKS, upstream: end of maintenance; GKE: end of standard support).
          support: date(r.eolFrom),
          // EKS extended support (extra fee), AKS long-term support (Premium tier).
          extended: date(r.eoesFrom),
        }))
        .sort((a, b) => byVersion(b.cycle, a.cycle)),
    };
  }
  write("platforms.json", { source: "https://endoflife.date", generated: today, platforms: out });
}

async function addons() {
  const out = {};
  for (const [key, id] of Object.entries(ADDONS)) {
    const result = await product(id);
    out[key] = {
      label: result.label,
      page: result.links?.html ?? `https://endoflife.date/${id}`,
      releases: result.releases
        .filter((r) => minor(r.name))
        .map((r) => ({
          cycle: minor(r.name),
          released: date(r.releaseDate),
          eol: date(r.eolFrom),
          latest: r.latest?.name ?? null,
        }))
        .sort((a, b) => byVersion(b.cycle, a.cycle)),
    };
  }
  write("addons.json", { source: "https://endoflife.date", generated: today, addons: out });
}

await apis();
await platforms();
await addons();
