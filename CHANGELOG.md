# Changelog

What changed in each JET Pilot release, newest first. It starts at 1.36, the release that rebuilt JET Pilot; older releases are on [GitHub](https://github.com/unxsist/jet-pilot/releases). The same changelog is at [jet-pilot.app/changelog](https://www.jet-pilot.app/changelog/).

<!--
How to write an entry (jet-pilot.app/changelog is generated from this file):
- One `## <version> (<YYYY-MM-DD>)` per release, newest first. The site only
  shows versions up to the latest published release, so an entry can be
  written before the release is cut; set its date on release day.
- Feature releases get a `### <title>` and may add one short paragraph.
  Patch releases skip both.
- Then `#### New`, `#### Improved`, `#### Fixed` and, when needed,
  `#### Upgrading`: lists of `**Lead.** Detail.` items, in plain words.
-->

## 2.2.0 (2026-10-15)

### GitOps, usage history and access review

JET Pilot now understands the tools around your workloads, and every side panel tells you what an object is doing.

#### New
- **GitOps.** One page for every Flux Kustomization, Flux HelmRelease and Argo CD Application across your clusters, problems first. Open one to see its source, what it delivered and why it fails, then reconcile, suspend, sync or refresh it.
- **Usage history.** CPU and memory charts (plus network for pods) over 1h, 6h, 24h or 7d in the side panel of pods, workloads, nodes and namespaces, with requests and limits drawn in. JET Pilot finds the cluster's Prometheus, Thanos Query or VictoriaMetrics by itself and queries it through the API server, so there's nothing to port-forward. Without one, the charts show metrics-server's last 15 minutes.
- **Access review.** Ask "Can I delete deployments in payments?" or "Who can…?" and get the answer with the binding and role behind it, or see everything a user, group or service account may do. Roles, bindings and service accounts get side panels that read like sentences.
- **Custom actions.** One small YAML file per action: open a URL, run a command or `kubectl`, exec into a container, apply a patch or copy text. They show up in row menus, the side panel and the command palette. Values from the cluster never become code, and actions that change the cluster go through the guardrails. Find them in Settings › Actions.
- **Operators and CRDs.** Every custom resource shows its CRD's printer columns, and well-known projects get their own sidebar sections. cert-manager, Gateway API, Karpenter, KEDA, External Secrets and Prometheus Operator get curated columns, states in words and side panels, with actions such as Renew, Pause and Sync now.

#### Improved
- **Native Helm.** Releases and their history load straight from the cluster, without the `helm` binary. A release panel shows notes, resources, values and a revision timeline that says what changed, with rollback and compare. Search your repositories and Artifact Hub, then install with a values editor checked against the chart's schema and a dry-run preview.
- **Side panels that explain.** Every panel opens with the object's state in a sentence and links to related objects, with sections for pods, nodes, services, ingresses, storage, HPAs, jobs, cron jobs, config maps and namespaces. Edit labels, annotations and node taints in place, with a preview before you save.
- **Port forwards that heal.** Forwards run over the Kubernetes API and follow their pod through restarts and rollouts. Ports show by name, forwards remember their local ports, and an HTTP tester sends requests through a forward.
- **Describe and YAML without `kubectl`.** Both now come straight from the Kubernetes API.
- **A faster start.** JET Pilot loads a fifth less code before it first draws, in a few files instead of twenty, and the side panel and dialogs follow right after.

## 2.1.2 (2026-10-13)

#### Fixed
- **The keyboard keeps working after a command palette pick.** After jumping somewhere from the palette (for example `:deploy`) or switching context there, typing didn't filter the table and <kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd> didn't open the palette again until you clicked somewhere.

## 2.1.1 (2026-10-12)

#### Fixed
- **Removing a cluster or cloud account works.** Remove in the confirmation did nothing.
- **Removal no longer gets stuck.** It only asks for your passphrase when the cluster stores credentials, keeps credentials another context still uses, and removes an account's clusters before its secrets.
- **The clusters hub stays in sync.** A refresh racing an account removal no longer brings clusters back, contexts deleted elsewhere (for example with `kubectl`) are disconnected, and kubeconfigs are read again when the window regains focus.
- **AWS MFA codes are submitted once**, and the session is kept.
- **Changing Protected for several clusters** applies to all of them.

## 2.1.0 (2026-10-12)

### Team roles on AWS, and switching your way

#### New
- **Assume team roles on AWS.** Signed in through IAM Identity Center with a personal permission set? Add the team roles you're allowed to assume, including roles in other accounts: paste a role ARN or pick one from `~/.aws/config`. JET Pilot finds the EKS clusters in the role's account, and `kubectl` tokens for those clusters use the role, in the app and in your terminal. Find it in Add cluster › AWS › IAM Identity Center.
- **Switch with a single pick.** Settings › Clusters › Context switcher can now switch straight to the cluster and namespace you pick and close the menu, like k9s, instead of adding them to the selection. Hold <kbd>⌘</kbd> / <kbd>Ctrl</kbd> while picking to do the other one.

## 2.0.0 (2026-10-05)

### Every cluster, every cloud, one calm app

#### New
- **The Clusters hub.** Every cluster from every kubeconfig and cloud account in one list, with live status (<kbd>⌘O</kbd> / <kbd>Ctrl+O</kbd>). Give clusters names, colours, environments, folders and tags, star favourites and hide the rest. Click one for its status, version, nodes, sign-in and kubeconfig.
- **Every cloud, built in.** Connect AWS (IAM Identity Center, a profile with MFA, or access keys), Google Cloud and Azure (through gcloud and az), DigitalOcean, Akamai/Linode, Civo, Scaleway, Vultr and Exoscale. JET Pilot finds their clusters and keeps the list current: new clusters wait for you in the hub, and clusters deleted in the cloud are flagged.
- **Add anything.** Paste or import a kubeconfig, or enter a cluster by hand, with Test connection. Added clusters live in JET Pilot's own kubeconfig (`~/.kube/jet-pilot/config`) with their credentials in your system keychain, and work in `kubectl` and `k9s` too.
- **Sign in without leaving the app.** Device codes and browser sign-ins for kubelogin, gcloud, az, AWS and OIDC plugins appear in JET Pilot, and lists, logs, metrics and port forwards reconnect afterwards. Background work never opens a browser.
- **Production guardrails.** Mark a cluster as production and its colour follows you everywhere. Deleting, draining or scaling to zero asks you to type the name, applying YAML runs a server-side dry run first, and read-only clusters can't be changed from JET Pilot at all.

#### Improved
- **Settings, rebuilt.** Every setting is searchable (<kbd>⌘,</kbd> / <kbd>Ctrl+,</kbd>), the ones you changed are marked, and there's a `settings.json` editor. Kubeconfig files are found by themselves, and JET Pilot can download kubectl, Helm and kubelogin for you, checked against their official checksums.
- **Calmer everywhere.** A design pass over the whole app: fewer boxes, clearer lists and status only when it needs you, plus a setup guide for new installs.

#### Upgrading
- **Settings move by themselves** to `settings.json` and `state.json`; the old file is kept as `settings.v1.backup.json`.
- **Your own kubeconfig is never changed.** To use clusters you added in JET Pilot from a terminal, add `~/.kube/jet-pilot/config` to `KUBECONFIG` (Settings › Advanced › Cluster credentials shows the line), or export them into `~/.kube/config` (a backup is made first).
- **On Linux without a keychain** (no Secret Service), JET Pilot asks for a passphrase the first time it stores a credential.

## 1.39.0 (2026-10-05)

### Updates you can count on

#### New
- **Announcements.** JET Pilot can show important notices from jet-pilot.app, such as how to update by hand when a release can't update itself. Dismissed notices stay dismissed.

#### Improved
- **The update dialog waits for the update.** It shows download progress and only offers Restart once the new version is in place. Before, restarting too early brought the old version back.
- **Failed updates are explained**, with Try again and a link to the download page. On macOS, the dialog shows how to clear the quarantine flag that stops an app from replacing itself.

## 1.38.1 (2026-10-05)

#### Improved
- **Calmer muted themes.** Status colours a theme doesn't define take their tone from the theme's own palette, and very bright accents are softened for selections and focus rings. Colours a theme sets itself are kept, unless they'd be unreadable.
- **Blossom, Grove, Ocean, Ember and Iris** now sit with the other built-in themes. A palette picked in 1.38.0 carries over.
- **Export › Standard theme…** writes a plain theme file without JET Pilot's extras.
- **What's New** only reappears for feature releases, not for patches.

## 1.38.0 (2026-10-05)

### Themes

#### New
- **Built-in themes.** JET plus favourites like Catppuccin, Tokyo Night, Dracula, Nord, GitHub, One Dark Pro, Rosé Pine and Gruvbox. Hover one in Settings › Appearance to preview it on the whole app.
- **Bring your own.** Drop in a VS Code, Sublime Text or TextMate theme. Light and dark variants pair up by themselves, and the YAML editor and terminal take the theme's syntax and ANSI colours.
- **Open VSX gallery.** Search and install VS Code themes without leaving the app. Only MIT-licensed themes can be installed, so JET Pilot stays MIT.
- **Write your own in JSON.** A canvas and an accent are enough; everything else is derived with readable contrast. Themes are plain files that reload as you edit them, and they validate in VS Code with `https://www.jet-pilot.app/schemas/theme.json`.
- **Switch in a keystroke.** <kbd>Mod</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> opens the theme picker with a live preview, and you can pick a different theme for light and dark mode.

#### Fixed
- **Readable suggestions** in the YAML editor's light theme.

## 1.37.0 (2026-10-05)

### Live, fast and seriously capable

#### New
- **Live lists.** Lists stream changes straight from the Kubernetes API instead of polling `kubectl`: updates appear in a fraction of a second, revisiting a view is instant, and pod tables show CPU and memory sparklines.
- **The resource graph, reimagined.** Every app in its own lane from Ingress to Service to Pods, with config, storage, identity and scaling attached. Health rolls up, missing references stand out, and Problems mode zooms to what's broken.
- **Logs across every pod.** Open logs on a Deployment, StatefulSet, DaemonSet, Job or Service to follow all its pods at once, colour-coded per pod, with search, filters, previous containers and export.
- **A smarter YAML editor.** Works offline, with autocompletion, docs and validation from your cluster's own schemas, CRDs included. Saving shows a diff and runs a server-side dry run first, and you can compare an object across contexts.
- **Rollouts, Helm and debugging.** Rollout history with diffs and rollback, Helm upgrades with a values diff, ephemeral debug containers, a node shell, and copying files to and from containers.
- **Workspaces and split view.** Save sets of contexts, namespaces, tabs and port forwards as workspaces, and put two tabs side by side. Tables gained a k9s-style row mode (<kbd>?</kbd> shows every shortcut) and column reordering, resizing and grouping.

#### Improved
- **Faster and leaner.** A faster startup, bounded memory everywhere and no orphaned `kubectl` processes. When a list can't be watched, it falls back to polling, and back again.

## 1.36.0 (2026-10-04)

### A whole new JET Pilot

The biggest release so far: a complete redesign, many clusters at once and a built-in terminal.

#### New
- **A new design.** Every screen redesigned, with polished dark and light themes, crisp typography and status colours you can read at a glance.
- **Many clusters and namespaces at once.** Connect several contexts across all your kubeconfig files, with any mix of namespaces. Tables combine them with Context and Namespace columns.
- **A built-in terminal.** <kbd>Ctrl</kbd>+<kbd>`</kbd> opens a terminal with `kubectl` pointed at the current context; your own kubeconfig is never touched. Container shells work on Windows too.
- **Keyboard first.** Better fuzzy search in the <kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd> palette, type-to-filter on every table and <kbd>⌘S</kbd> / <kbd>Ctrl+S</kbd> in the YAML editor.
- **Linux on ARM64.** Native `aarch64` builds as `.deb`, `.rpm` and AppImage.

#### Improved
- **Richer side panels** with containers, conditions, labels and events, and one-click YAML, describe and logs. Tables gained loading, error and empty states, stable selection and live status colours.
- **Safer.** A strict content security policy, minimal permissions, SSO tokens that are never shown, and edited manifests (Secrets included) piped to `kubectl` instead of written to disk.

#### Fixed
- **Port forwards** that never became ready, copying text in describe, the missing PersistentVolumes view, context search, "All namespaces" showing only `default`, a resource graph stuck loading, closed tabs that kept streaming, and crashes in the log viewer.
