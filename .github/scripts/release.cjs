// Helpers for .github/workflows/release.yml, run through actions/github-script
// (`github` is an authenticated Octokit, `core` is @actions/core).
const fs = require("fs");

const OWNER = "unxsist";
const REPO = "jet-pilot";
const SITE = "https://www.jet-pilot.app";

/* ------------------------------------------------------------ changelog */

/** The CHANGELOG.md entry for `version`: { date, body } or null. */
function changelogEntry(version, text = fs.readFileSync("CHANGELOG.md", "utf8")) {
  const escaped = version.replace(/\./g, "\\.");
  const heading = new RegExp(`^## ${escaped} \\((\\d{4}-\\d{2}-\\d{2})\\)\\s*$`, "m");
  const match = heading.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
  return { date: match[1], body };
}

/* --------------------------------------------------------------- assets */

/** Every file a release must carry (the five platform builds). */
function expectedAssets(version) {
  const v = version;
  return [
    `JET.Pilot_${v}_aarch64.dmg`,
    `JET.Pilot_${v}_x64.dmg`,
    "JET.Pilot_aarch64.app.tar.gz",
    "JET.Pilot_aarch64.app.tar.gz.sig",
    "JET.Pilot_x64.app.tar.gz",
    "JET.Pilot_x64.app.tar.gz.sig",
    `JET.Pilot_${v}_x64-setup.exe`,
    `JET.Pilot_${v}_x64-setup.exe.sig`,
    `JET.Pilot_${v}_x64_en-US.msi`,
    `JET.Pilot_${v}_x64_en-US.msi.sig`,
    `JET.Pilot_${v}_amd64.AppImage`,
    `JET.Pilot_${v}_amd64.AppImage.sig`,
    `JET.Pilot_${v}_amd64.deb`,
    `JET.Pilot-${v}-1.x86_64.rpm`,
    `JET.Pilot_${v}_aarch64.AppImage`,
    `JET.Pilot_${v}_aarch64.AppImage.sig`,
    `JET.Pilot_${v}_arm64.deb`,
    `JET.Pilot-${v}-1.aarch64.rpm`,
    "latest.json",
  ];
}

/** Updater platforms latest.json must list (what installed apps ask for). */
const UPDATER_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
  "linux-x86_64",
  "linux-aarch64",
];

/**
 * Problems with a release's files: missing assets, empty files, or a
 * latest.json that doesn't serve every platform. Empty when it's complete.
 */
function checkRelease(version, assets, manifest) {
  const problems = [];
  const byName = new Map(assets.map((a) => [a.name, a]));
  for (const name of expectedAssets(version)) {
    const asset = byName.get(name);
    if (!asset) problems.push(`missing ${name}`);
    else if (!asset.size) problems.push(`${name} is empty`);
  }
  if (!manifest) return problems.concat("latest.json can't be read");
  if (manifest.version !== version) {
    problems.push(`latest.json says ${manifest.version}, not ${version}`);
  }
  const platforms = manifest.platforms || {};
  for (const platform of UPDATER_PLATFORMS) {
    const entry = platforms[platform];
    if (!entry) {
      problems.push(`latest.json has no ${platform}`);
      continue;
    }
    if (!entry.signature || entry.signature.length < 100) {
      problems.push(`latest.json ${platform} has no signature`);
    }
    const file = decodeURIComponent(String(entry.url).split("/").pop());
    if (!String(entry.url).includes(`/releases/download/v${version}/`)) {
      problems.push(`latest.json ${platform} points at ${entry.url}`);
    } else if (!byName.has(file)) {
      problems.push(`latest.json ${platform} points at ${file}, which isn't attached`);
    }
  }
  return problems;
}

/** Downloads a (draft) release's latest.json through the API. */
async function readManifest(github, assets) {
  const asset = assets.find((a) => a.name === "latest.json");
  if (!asset) return null;
  const { data } = await github.rest.repos.getReleaseAsset({
    owner: OWNER,
    repo: REPO,
    asset_id: asset.id,
    headers: { accept: "application/octet-stream" },
  });
  try {
    return JSON.parse(Buffer.from(data).toString("utf8"));
  } catch {
    return null;
  }
}

async function verify({ github, core, version, releaseId }) {
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
    owner: OWNER,
    repo: REPO,
    release_id: Number(releaseId),
    per_page: 100,
  });
  const manifest = await readManifest(github, assets);
  const problems = checkRelease(version, assets, manifest);
  if (problems.length) {
    core.setFailed(
      `v${version} isn't complete:\n- ${problems.join("\n- ")}\n` +
        "Re-run the Build job of the platform that's missing, then Verify.",
    );
    return;
  }
  core.info(`v${version}: ${assets.length} files, updater serves ${UPDATER_PLATFORMS.join(", ")}`);
}

/* ----------------------------------------------------------------- body */

const INSTALL = `### Install
- **macOS**: \`brew install --cask unxsist/tap/jet-pilot\`, or download the \`.dmg\` for Apple Silicon (\`aarch64\`) or Intel (\`x64\`).

  > [!IMPORTANT]
  > JET Pilot isn't notarized by Apple. The Homebrew tap removes the quarantine flag for you. If you install the \`.dmg\` yourself and macOS says the app *"is damaged"* or *"can't be verified"*, run this once:
  > \`\`\`bash
  > xattr -dr com.apple.quarantine "/Applications/JET Pilot.app"
  > \`\`\`
- **Windows**: the \`.exe\` or \`.msi\` installer (SmartScreen: *More info → Run anyway*).
- **Linux**: \`.deb\`, \`.rpm\` or \`.AppImage\` for x64 and ARM64.

Existing installs update themselves.`;

/**
 * The release page: the CHANGELOG entry, install steps, and the commit
 * list semantic-release generated (`generated`, folded away).
 */
function releaseBody(version, entry, generated) {
  // semantic-release's notes start with a `# [x.y.z](compare) (date)` line.
  const commits = (generated || "").replace(/^#{1,2} \[?\d+\.\d+\.\d+.*\n+/, "").trim();
  const parts = [
    entry.body,
    `The full history is in the [changelog](${SITE}/changelog/).`,
    INSTALL,
  ];
  if (commits) {
    parts.push(`<details>\n<summary>Commits</summary>\n\n${commits}\n\n</details>`);
  }
  return parts.join("\n\n") + "\n";
}

async function publish({ github, core, version, releaseId }) {
  const entry = changelogEntry(version);
  if (!entry) {
    core.setFailed(`CHANGELOG.md has no entry for ${version}`);
    return;
  }
  const { data: release } = await github.rest.repos.getRelease({
    owner: OWNER,
    repo: REPO,
    release_id: Number(releaseId),
  });
  const body = release.draft && !release.body?.includes("<summary>Commits</summary>")
    ? releaseBody(version, entry, release.body)
    : release.body;
  const { data: published } = await github.rest.repos.updateRelease({
    owner: OWNER,
    repo: REPO,
    release_id: release.id,
    name: `v${version}`,
    body,
    draft: false,
    make_latest: "true",
  });
  core.info(`Published ${published.html_url}`);
  return published.html_url;
}

/* --------------------------------------------------------------- notify */

const MARKER = (version) => `<!-- jet-pilot-release:v${version} -->`;

/** PR numbers in the commits between two tags (squash merges end in `(#n)`). */
async function releasedPullRequests(github, base, head) {
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    owner: OWNER,
    repo: REPO,
    basehead: `${base}...${head}`,
    per_page: 250,
  });
  const numbers = new Set();
  for (const { commit } of data.commits) {
    const subject = commit.message.split("\n")[0];
    for (const m of subject.matchAll(/\(#(\d+)\)/g)) numbers.add(Number(m[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

/** The issues a PR closes (its "Fixes #n" links), in this repository. */
async function closingIssues(github, number) {
  const query = `query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 25) {
          nodes { number repository { nameWithOwner } }
        }
      }
    }
  }`;
  const result = await github.graphql(query, { owner: OWNER, repo: REPO, number });
  return result.repository.pullRequest.closingIssuesReferences.nodes
    .filter((n) => n.repository.nameWithOwner === `${OWNER}/${REPO}`)
    .map((n) => n.number);
}

/** The tag before `tag` (by version), or null for the first release. */
async function previousTag(github, tag) {
  const tags = await github.paginate(github.rest.repos.listTags, { owner: OWNER, repo: REPO, per_page: 100 });
  const parse = (t) => t.replace(/^v/, "").split(".").map(Number);
  const newer = (a, b) => {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  const older = tags
    .map((t) => t.name)
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t) && newer(tag, t))
    .sort((a, b) => (newer(a, b) ? -1 : 1));
  return older[0] || null;
}

async function comment(github, core, number, body, marker, dryRun) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: OWNER,
    repo: REPO,
    issue_number: number,
    per_page: 100,
  });
  if (comments.some((c) => c.body?.includes(marker))) {
    core.info(`#${number}: already told`);
    return false;
  }
  if (dryRun) {
    core.info(`#${number}: would comment`);
    return true;
  }
  await github.rest.issues.createComment({ owner: OWNER, repo: REPO, issue_number: number, body });
  core.info(`#${number}: commented`);
  return true;
}

/**
 * Tells every PR in the release, and every issue those PRs fix, that the
 * release is out; closes fixed issues that are still open. Idempotent: a
 * hidden marker keeps a rerun from commenting twice.
 */
async function notify({ github, core, version, dryRun = false }) {
  const tag = `v${version}`;
  const base = await previousTag(github, tag);
  if (!base) {
    core.info("No earlier release; nothing to notify");
    return;
  }
  const url = `https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`;
  const marker = MARKER(version);
  const prs = await releasedPullRequests(github, base, tag);
  const issues = new Set();
  for (const pr of prs) {
    for (const issue of await closingIssues(github, pr)) issues.add(issue);
  }
  core.info(`${tag}: PRs ${prs.map((n) => `#${n}`).join(", ") || "none"}; issues ${[...issues].map((n) => `#${n}`).join(", ") || "none"}`);

  for (const pr of prs) {
    await comment(github, core, pr, `${marker}\nReleased in [JET Pilot ${version}](${url}).`, marker, dryRun);
  }
  for (const number of issues) {
    const body = `${marker}\nThe fix for this is out in [JET Pilot ${version}](${url}). Existing installs update themselves; you can also download it from the release page.`;
    await comment(github, core, number, body, marker, dryRun);
    const { data: issue } = await github.rest.issues.get({ owner: OWNER, repo: REPO, issue_number: number });
    if (issue.state === "open" && !dryRun) {
      await github.rest.issues.update({
        owner: OWNER,
        repo: REPO,
        issue_number: number,
        state: "closed",
        state_reason: "completed",
      });
      core.info(`#${number}: closed`);
    }
  }
}

module.exports = {
  changelogEntry,
  expectedAssets,
  checkRelease,
  releaseBody,
  verify,
  publish,
  notify,
  previousTag,
  releasedPullRequests,
};
