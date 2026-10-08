# JET Pilot

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/header-dark.webp">
    <source media="(prefers-color-scheme: light)" srcset="public/header-light.webp">
    <img alt="JET Pilot — Kubernetes, beautifully." src="public/header-dark.webp">
  </picture>
</p>

<p align="center">
  <b>The open-source Kubernetes IDE that focuses on less clutter, speed and good looks.</b><br/>
  Free · MIT licensed · macOS, Windows &amp; Linux (x64 and ARM64) · <a href="https://www.jet-pilot.app">jet-pilot.app</a>
</p>

## Introduction
JET Pilot is an open-source K8s IDE. It was created out of frustration, as all "good-looking" K8s IDEs went commercial. Power-users nowadays resort to tools like `k9s`, which works great, but heavily relies on keyboard input. JET Pilot combines a keyboard-first workflow with a polished, mouse-friendly desktop UI — built with Rust and Tauri, so it stays small and fast.

No account, no tracking: JET Pilot uses your existing kubeconfig files and `kubectl`, and connects your cloud accounts when you want it to. To count how many installs are in use, the update check on startup sends the version, the platform and whether it is the first check today, this week or this month. Nothing identifies you or your machine, the update server keeps only daily totals, and Settings › General turns it off.

## What's new in 2.0
- **Clusters hub**: every cluster from every kubeconfig and cloud account in one list, with live status. Give clusters names, colours, environments, folders and tags; click one for everything about it.
- **Every cloud**: connect AWS (IAM Identity Center, profiles or access keys), Google Cloud and Azure (through gcloud and az), DigitalOcean, Akamai/Linode, Civo, Scaleway, Vultr and Exoscale. JET Pilot finds their clusters and keeps the list current.
- **Add anything**: paste or import a kubeconfig, or enter a cluster by hand. Added clusters live in JET Pilot's own kubeconfig (`~/.kube/jet-pilot/config`), with their credentials in your system keychain, and work in `kubectl` and `k9s` too.
- **Sign in without leaving the app**: device codes and browser sign-ins appear in JET Pilot, and every view reconnects afterwards.
- **Production guardrails**: protected clusters ask you to type the name before destructive actions; read-only clusters can't be changed from JET Pilot.
- **Settings, rebuilt**: searchable, with a `settings.json` editor. Plus a setup guide for new installs and a calmer design across the whole app.

## Features
- **Multi-cluster & multi-namespace**: connect to several contexts (across multiple kubeconfig files) and namespaces at once; every table aggregates them with Context and Namespace columns.
- **Built-in terminal**: open a local terminal (<kbd>Ctrl</kbd>+<kbd>`</kbd>) with `kubectl` preconfigured for the current context — your own kubeconfig is never modified. Shell into any container with one click, on macOS, Linux and Windows.
- **Resource graph**: see how Services, Deployments, ReplicaSets, Pods, ConfigMaps and Secrets relate, with live health indicators.
- **Structured log viewer**: follow logs, parse JSON log lines into fields and filter them with facets.
- **Object management**: browse, describe, create and edit any Kubernetes object in a full YAML editor (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>S</kbd> to apply).
- **Command palette**: <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> to jump anywhere, switch contexts and namespaces or open a terminal — with fuzzy search.
- **Port forwarding**, **Helm** releases and charts, **pod metrics**, events, scaling, rollouts, cordon/drain and more.
- **SSO-friendly**: in-app sign-in for AWS IAM Identity Center, gcloud, az, kubelogin/OIDC and other exec plugins, with device codes shown in the app.
- **A premium, accessible UI** with polished dark and light themes.

## Installation

Download the latest release for your platform from the [releases page](https://github.com/unxsist/jet-pilot/releases/latest/) or from [jet-pilot.app](https://www.jet-pilot.app). JET Pilot updates itself automatically.

JET Pilot uses [`kubectl`](https://kubernetes.io/docs/tasks/tools/) (and `helm` for the Helm views). When they aren't on your `PATH`, it can download them for you, verified against their official checksums (Settings › Advanced).

### macOS

Install with Homebrew from the JET Pilot tap:

```bash
brew install --cask unxsist/tap/jet-pilot
```

The tap's cask clears macOS's quarantine flag after installing, so the app opens right away and keeps itself up to date.

> [!NOTE]
> JET Pilot is no longer in Homebrew's main cask repository: since October 2026 Homebrew only accepts apps notarized by Apple there. If you installed it with `brew install --cask jet-pilot` before, switch once with `brew uninstall --cask jet-pilot && brew install --cask unxsist/tap/jet-pilot` (your settings are kept).

…or download the `.dmg` for Apple Silicon (`aarch64`) or Intel (`x64`), open it and drag JET Pilot into your Applications folder.

> [!IMPORTANT]
> **JET Pilot is not notarized by Apple.** It's free and open source, and we'd rather not pay Apple's yearly developer fee. When you install the `.dmg` yourself, macOS will say the app *"is damaged and can't be opened"* or *"cannot be verified"*. Remove the quarantine flag once after installing:
>
> ```bash
> xattr -dr com.apple.quarantine "/Applications/JET Pilot.app"
> ```
>
> That's it — automatic updates keep working afterwards. (The Homebrew tap does this for you.)

### Linux

Packages are available for x64 (`amd64` / `x86_64`) and ARM64 (`aarch64`):

- **Debian / Ubuntu**: `sudo apt install ./JET.Pilot_<version>_<arch>.deb`
- **Fedora / RHEL / openSUSE**: `sudo rpm -i JET.Pilot-<version>-1.<arch>.rpm`
- **AppImage** (any distribution): `chmod +x JET.Pilot_<version>_<arch>.AppImage` and run it.

### Windows

Download the `.exe` (or `.msi`) installer and run it. The installer isn't code-signed, so Windows SmartScreen may warn you — click **More info → Run anyway**.

## Contributing

Issues and pull requests are very welcome! JET Pilot is built with [Tauri v2](https://tauri.app) (Rust) and [Vue 3](https://vuejs.org).

```bash
npm ci
npm run dev             # run the app
npx vitest run          # unit tests
npm run harness         # UI in the browser with mocked cluster data (no cluster needed)
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org); releases are created with semantic-release.

## License

[MIT](LICENSE)
