<script setup lang="ts">
/*
 * Connect Google Cloud, Azure, DigitalOcean, Akamai, Civo, Scaleway, Vultr
 * or Exoscale and add their clusters: sign in through the provider's CLI
 * (gcloud, az, doctl) or paste an API token / key, narrow down what to look
 * at (projects, subscriptions, regions, zones), then pick the clusters.
 * AWS has its own flow (AwsConnect). Clusters you don't add stay available
 * in the Clusters hub.
 *
 * With `connectionId`, edits an existing account (scopes, regions).
 */
import { invoke } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ArrowLeft, CircleAlert, ExternalLink, KeyRound, Loader2, RefreshCw, SquareTerminal, TriangleAlert } from "lucide-vue-next";
import { RadioGroupRoot } from "radix-vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import WizardFooter from "@/components/wizard/WizardFooter.vue";
import ChoiceRow from "@/components/wizard/ChoiceRow.vue";
import { WIZARD_BODY, WIZARD_ERROR, WIZARD_LIST, WIZARD_ROW } from "@/components/wizard/wizard";
import LoginSessionPanel from "@/components/auth/LoginSessionPanel.vue";
import CatalogPicker from "./CatalogPicker.vue";
import { useLoginSession } from "@/lib/auth/useLoginSession";
import { useClusters } from "@/lib/clusters/useClusters";
import { discoverKubeconfigs } from "@/lib/kubeconfigSources";
import { errorMessage, withVault } from "@/lib/clusters/managed";
import {
  catalogAdd,
  cloudCliSignIn,
  cloudCliStatus,
  connectionScopes,
  createConnection,
  deleteConnection,
  listConnections,
  providerRegions,
  updateConnection,
  type CatalogCluster,
  type CliProvider,
  type CloudCliStatus,
  type CloudConnection,
  type CloudProvider,
  type ConnectionKind,
  type ConnectionScope,
  type TokenProvider,
} from "@/lib/clusters/cloud";
import { catalogWhere, failureGroups, type DiscoveryScope } from "@/lib/clusters/cloudModel";
import { parseGroups, providerInfo, tokenLooksValid } from "@/lib/clusters/providers";
import { catalog, discovery, refreshCloud } from "@/lib/clusters/catalogStore";
import type { ContextRef } from "@/lib/contextKey";

const props = defineProps<{ provider: CloudProvider; connectionId?: string | null; folders?: string[] }>();
const emit = defineEmits<{
  back: [];
  done: [added: ContextRef[], warnings?: { key: string; message: string }[]];
  heading: [heading: { title: string; description: string }];
}>();

const clusters = useClusters();
const info = computed(() => providerInfo(props.provider));

type Step = "method" | "cli" | "token" | "apiKey" | "signin" | "scopes" | "regions" | "discover";
const step = ref<Step>("method");
const history = reactive<Step[]>([]);
const go = (next: Step) => {
  history.push(step.value);
  step.value = next;
  error.value = null;
};
/* Sign-ins and the CLI check are left behind: Back goes to the form before them. */
const replace = (next: Step) => {
  if (step.value !== "signin") history.push(step.value);
  step.value = next;
  error.value = null;
};
const back = () => {
  if (step.value === "signin") void login.cancel();
  const previous = history.pop();
  error.value = null;
  if (previous) step.value = previous;
  else emit("back");
};

const busy = ref(false);
const error = ref<string | null>(null);
const run = async (operation: () => Promise<void>) => {
  busy.value = true;
  error.value = null;
  try {
    await operation();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
};

/* The account being set up; deleted again when the flow is abandoned before discovery. */
const connection = shallowRef<CloudConnection | null>(null);
let createdHere = false;
let kept = false;
onBeforeUnmount(() => {
  if (connection.value && createdHere && !kept) void deleteConnection(connection.value.id, false).catch(() => undefined);
});
const replaceConnection = async (next: () => Promise<CloudConnection>) => {
  if (connection.value && createdHere) await deleteConnection(connection.value.id, false).catch(() => undefined);
  connection.value = await next();
  createdHere = true;
};

/* After connecting: projects/subscriptions, then regions, then the clusters. */
const nextAfterConnect = () => {
  if (info.value.scopes) return void loadScopes();
  if (info.value.regional) return void replace("regions");
  void findClusters();
};

const pickMethod = (kind: ConnectionKind) => {
  if (kind === "cli") {
    go("cli");
    void loadCli();
  } else go(kind === "apiKey" ? "apiKey" : "token");
};

/* ----------------------------------------------------------------- CLI -- */

const cli = ref<CloudCliStatus | null>(null);
const cliAccount = ref<string>("");
const loadCli = () =>
  run(async () => {
    cli.value = null;
    cli.value = await cloudCliStatus(props.provider as CliProvider);
    cliAccount.value = cli.value.account ?? cli.value.accounts[0] ?? "";
  });

const useCli = () =>
  run(async () => {
    await replaceConnection(() =>
      createConnection({
        kind: "cli",
        provider: props.provider as CliProvider,
        cliAccount: cliAccount.value && cliAccount.value !== cli.value?.account ? cliAccount.value : undefined,
      })
    );
    if (connection.value!.status !== "signedIn") throw new Error(connection.value!.message ?? `Sign in with ${info.value.cli!.tool} first.`);
    nextAfterConnect();
  });

const login = useLoginSession(
  {
    start: (channel) => cloudCliSignIn(props.provider as CliProvider, channel),
    cancel: (sessionId) => invoke("auth_login_cancel", { sessionId }),
    openUrl: (sessionId, url) => invoke("auth_login_open_url", { sessionId, url }),
  },
  (finished) => {
    if (finished.phase !== "succeeded") return;
    setTimeout(() => {
      if (step.value !== "signin") return;
      replace("cli");
      void loadCli();
    }, 700);
  }
);
const signInWithCli = () => {
  go("signin");
  login.begin();
};

/* --------------------------------------------------------- token / key -- */

const token = ref("");
const projectId = ref("");
const label = ref("");
const tokenValid = computed(() => tokenLooksValid(props.provider, token.value));
const useToken = () =>
  run(async () => {
    await replaceConnection(() =>
      withVault(() =>
        createConnection({
          kind: "token",
          provider: props.provider as TokenProvider,
          token: token.value.trim(),
          projectId: projectId.value.trim() || undefined,
          label: label.value.trim() || undefined,
        })
      )
    );
    if (connection.value!.status !== "signedIn") throw new Error(connection.value!.message ?? "The provider didn't accept this token.");
    token.value = "";
    nextAfterConnect();
  });

const apiKey = reactive({ key: "", secret: "", user: "jet-pilot", groups: "system:masters" });
const showAdvanced = ref(false);
const keyValid = computed(() => /^EXO[0-9a-f]{20,}$/i.test(apiKey.key.trim()) && apiKey.secret.trim().length >= 20);
const useApiKey = () =>
  run(async () => {
    await replaceConnection(() =>
      withVault(() =>
        createConnection({
          kind: "apiKey",
          provider: "exoscale",
          key: apiKey.key.trim(),
          secret: apiKey.secret.trim(),
          user: apiKey.user.trim() || undefined,
          groups: parseGroups(apiKey.groups),
          label: label.value.trim() || undefined,
        })
      )
    );
    if (connection.value!.status !== "signedIn") throw new Error(connection.value!.message ?? "Exoscale didn't accept this key.");
    apiKey.secret = "";
    nextAfterConnect();
  });

/* -------------------------------------------- projects / subscriptions -- */

const scopes = ref<ConnectionScope[] | null>(null);
const scopeMode = ref<"all" | "some">("all");
const pickedScopes = reactive(new Set<string>());
const scopeFilter = ref("");
const loadScopes = () =>
  run(async () => {
    if (step.value !== "scopes") replace("scopes");
    scopes.value = null;
    const list = await connectionScopes(connection.value!.id);
    list.sort((a, b) => a.name.localeCompare(b.name));
    const saved = connection.value!.targets.map((t) => t.accountId);
    scopeMode.value = saved.length ? "some" : "all";
    pickedScopes.clear();
    (saved.length ? saved : list.map((s) => s.id)).forEach((id) => pickedScopes.add(id));
    scopes.value = list;
  });
const shownScopes = computed(() => {
  const words = scopeFilter.value.trim().toLowerCase();
  return (scopes.value ?? []).filter((s) => !words || s.name.toLowerCase().includes(words) || s.id.toLowerCase().includes(words));
});
const saveScopes = () =>
  run(async () => {
    const targets =
      scopeMode.value === "all"
        ? []
        : (scopes.value ?? []).filter((s) => pickedScopes.has(s.id)).map((s) => ({ accountId: s.id, accountName: s.name, roleName: "" }));
    connection.value = await updateConnection(connection.value!.id, { targets });
    if (info.value.regional) go("regions");
    else await findClusters();
  });

/* -------------------------------------------------------------- regions -- */

const regions = ref<string[]>([]);
const regionMode = ref<"all" | "some">("all");
const pickedRegions = reactive(new Set<string>());
watch(step, async (current) => {
  if (current !== "regions" || !connection.value) return;
  const saved = connection.value.regions;
  regionMode.value = saved.length ? "some" : "all";
  pickedRegions.clear();
  saved.forEach((r) => pickedRegions.add(r));
  if (!regions.value.length) regions.value = await providerRegions(props.provider).catch(() => [] as string[]);
});
const saveRegions = () =>
  run(async () => {
    connection.value = await updateConnection(connection.value!.id, {
      regions: regionMode.value === "all" ? [] : [...pickedRegions].sort(),
    });
  }).then(() => (error.value ? undefined : findClusters()));

/* ------------------------------------------------------------- discover -- */

const found = computed<CatalogCluster[]>(() => {
  const id = connection.value?.id;
  const live = discovery.value?.clusters ?? catalog.value ?? [];
  return live
    .filter((c) => c.connectionId === id)
    .sort((a, b) => catalogWhere(a).localeCompare(catalogWhere(b)) || a.name.localeCompare(b.name));
});
const discovering = computed(() => !!discovery.value);
const checking = computed(() => {
  const running = discovery.value?.scopes.filter((s) => s.state === "running" && s.scope !== "regions") ?? [];
  return running[running.length - 1]?.scope ?? null;
});
const lastFailures = shallowRef<DiscoveryScope[]>([]);
const failures = computed(() => failureGroups(discovery.value?.scopes.filter((s) => s.state === "error") ?? lastFailures.value));
const selected = ref<string[]>([]);
const folder = ref("");

const findClusters = async () => {
  const id = connection.value!.id;
  kept = true;
  folder.value ||= connection.value!.label;
  selected.value = [];
  if (step.value !== "discover") go("discover");
  error.value = null;
  try {
    const finished = await refreshCloud([id]);
    lastFailures.value = finished.scopes.filter((s) => s.state === "error");
  } catch (e) {
    error.value = errorMessage(e);
  }
};

const chosen = computed(() =>
  found.value.filter((c) => c.state !== "added" && c.state !== "removed" && selected.value.includes(c.key))
);
const addClusters = () =>
  run(async () => {
    const result = await withVault(() => catalogAdd(chosen.value.map((c) => c.key), folder.value.trim() || null));
    if (folder.value.trim()) clusters.updateMany(result.added, { folder: folder.value.trim() });
    void discoverKubeconfigs(true);
    if (result.failed.length && !result.added.length) throw new Error(result.failed.map((f) => f.message).join("\n"));
    emit("done", result.added, result.warnings ?? []);
  });

/* ----------------------------------------------------------------- setup -- */

onMounted(async () => {
  if (!props.connectionId) {
    const methods = info.value.methods;
    if (methods.length === 1) {
      step.value = methods[0] === "cli" ? "cli" : methods[0] === "apiKey" ? "apiKey" : "token";
      if (methods[0] === "cli") void loadCli();
    }
    return;
  }
  await run(async () => {
    const existing = (await listConnections()).find((c) => c.id === props.connectionId);
    if (!existing) throw new Error("This account was removed.");
    connection.value = existing;
    if (existing.kind === "cli" && existing.status !== "signedIn") {
      step.value = "cli";
      void loadCli();
    } else if (info.value.scopes) await loadScopes();
    else step.value = info.value.regional ? "regions" : "discover";
    history.length = 0;
    if (step.value === "discover") void findClusters();
  });
});

/* Editing an account starts at its first step: nothing to go back to. */
const canGoBack = computed(() => !(props.connectionId && !history.length));

const productLine = computed(() => `${info.value.product} clusters`);
const headings: Record<Step, () => [string, string]> = {
  method: () => [`Connect ${info.value.name}`, `JET Pilot finds your ${productLine.value} and keeps the list current.`],
  cli: () => [`Connect ${info.value.name}`, `Through the ${info.value.cli?.name ?? "CLI"} you already use.`],
  token: () => [`Connect ${info.value.name}`, `With ${withArticle(info.value.token?.label ?? "API token")}, kept in your system keychain.`],
  apiKey: () => [`Connect ${info.value.name}`, "With an API key and secret, kept in your system keychain."],
  signin: () => [`Sign in with ${info.value.cli?.tool ?? "the CLI"}`, "Finish in your browser; JET Pilot continues by itself."],
  scopes: () => [`Choose ${info.value.scopes?.plural ?? "scopes"}`, `Where JET Pilot looks for ${productLine.value}.`],
  regions: () => [`Where to look for clusters`, `${info.value.regional?.noun === "zone" ? "Zones" : "Regions"} to check for ${productLine.value}.`],
  discover: () => [
    discovering.value
      ? `Looking for ${productLine.value}…`
      : `${found.value.length} ${found.value.length === 1 ? "cluster" : "clusters"} found`,
    "Clusters you don't add stay available in the Clusters hub.",
  ],
};
watch(
  () => headings[step.value](),
  ([title, description]) => emit("heading", { title, description }),
  { immediate: true }
);

const METHOD_TEXT: Partial<Record<ConnectionKind, { title: string; text: string; icon: typeof KeyRound }>> = {
  token: { title: "API token", text: "Paste a token from the control panel", icon: KeyRound },
  cli: { title: "Your doctl sign-in", text: "Use the account doctl is signed in to", icon: SquareTerminal },
};
/* "API token" → "an API token", "Secret key" → "a secret key". */
const withArticle = (label: string) => {
  const phrase = /^[A-Z]{2,}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
  return `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
};
const regionNoun = computed(() => (info.value.regional?.noun === "zone" ? "zone" : "region"));
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div :class="WIZARD_BODY">
      <!-- Method (DigitalOcean: token or doctl) -->
      <div v-if="step === 'method'" :class="WIZARD_LIST">
        <button
          v-for="(kind, index) in info.methods"
          :key="kind"
          type="button"
          :class="[WIZARD_ROW, 'w-full py-2.5 text-left focus-ring']"
          @click="pickMethod(kind)"
        >
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <component :is="METHOD_TEXT[kind]?.icon ?? KeyRound" class="h-4 w-4" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2 text-sm font-medium">
              {{ METHOD_TEXT[kind]?.title ?? kind }}
              <span v-if="index === 0" class="text-xs font-normal text-link">Recommended</span>
            </span>
            <span class="block truncate text-xs text-muted-foreground">{{ METHOD_TEXT[kind]?.text }}</span>
          </span>
        </button>
      </div>

      <!-- CLI -->
      <div v-else-if="step === 'cli'" class="space-y-4">
        <div v-if="!cli" class="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" /> Checking {{ info.cli?.tool }}…
        </div>
        <template v-else-if="!cli.installed">
          <div class="rounded-xl bg-muted/50 px-6 py-7 text-center">
            <p class="text-sm font-medium">The {{ info.cli?.name }} isn't installed</p>
            <p class="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              Install it, sign in once with <span class="font-mono">{{ info.cli?.tool }}</span>, then check again.
              JET Pilot never changes its configuration.
            </p>
            <div class="mt-4 flex justify-center gap-2">
              <Button variant="outline" size="sm" @click="openExternal(cli.installUrl)">
                <ExternalLink class="h-3.5 w-3.5" /> How to install
              </Button>
              <Button variant="ghost" size="sm" :disabled="busy" @click="loadCli">
                <RefreshCw class="h-3.5 w-3.5" :class="busy ? 'animate-spin' : ''" /> Check again
              </Button>
            </div>
          </div>
        </template>
        <template v-else-if="!cli.signedIn">
          <div class="rounded-xl bg-muted/50 px-6 py-7 text-center">
            <p class="text-sm font-medium">{{ info.cli?.tool }} isn't signed in</p>
            <p v-if="provider === 'digitalocean'" class="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              Run <span class="font-mono">doctl auth init</span> in a terminal, then check again. Or go back and use an API
              token.
            </p>
            <p v-else class="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              Sign in here; it's the same sign-in <span class="font-mono">{{ info.cli?.tool }}</span> uses in your terminal.
            </p>
            <div class="mt-4 flex justify-center gap-2">
              <Button v-if="provider !== 'digitalocean'" size="sm" @click="signInWithCli">Sign in with {{ info.cli?.tool }}</Button>
              <Button variant="ghost" size="sm" :disabled="busy" @click="loadCli">
                <RefreshCw class="h-3.5 w-3.5" :class="busy ? 'animate-spin' : ''" /> Check again
              </Button>
            </div>
          </div>
        </template>
        <template v-else>
          <p class="text-sm text-muted-foreground">
            <span class="font-mono text-xs">{{ info.cli?.tool }}</span> {{ cli.version ? `${cli.version} ` : "" }}is signed in.
            <template v-if="cli.accounts.length > 1">Which account should JET Pilot use?</template>
          </p>
          <RadioGroupRoot v-if="cli.accounts.length > 1" v-model="cliAccount" :class="WIZARD_LIST" aria-label="Account">
            <ChoiceRow
              v-for="account in cli.accounts"
              :key="account"
              :value="account"
              :title="account"
              :description="account === cli.account ? 'Active in the CLI' : undefined"
            />
          </RadioGroupRoot>
          <div v-else :class="[WIZARD_ROW, 'hover:bg-transparent', '-mx-3']">
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <SquareTerminal class="h-4 w-4" />
            </span>
            <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ cli.account ?? "Signed in" }}</span>
          </div>
          <p
            v-if="cli.authPlugin && !cli.authPlugin.installed"
            class="flex items-start gap-2 rounded-lg bg-warning/[0.07] px-3 py-2.5 text-xs text-warning"
          >
            <TriangleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
            <span v-if="cli.authPlugin.name === 'gke-gcloud-auth-plugin'">
              Clusters sign in with gke-gcloud-auth-plugin, which isn't installed. Run
              <span class="font-mono">gcloud components install gke-gcloud-auth-plugin</span>.
            </span>
            <span v-else>
              Clusters sign in with kubelogin, which isn't installed. JET Pilot can download it in Settings › Advanced.
            </span>
          </p>
        </template>
      </div>

      <!-- API token -->
      <form v-else-if="step === 'token' && info.token" class="space-y-5" @submit.prevent="tokenValid && useToken()">
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label for="cloud-token" class="text-sm text-muted-foreground">{{ info.token.label }}</label>
            <button type="button" class="flex items-center gap-1 text-xs text-link hover:underline" @click="openExternal(info.token.url)">
              Create one <ExternalLink class="h-3 w-3" />
            </button>
          </div>
          <Input
            id="cloud-token"
            v-model="token"
            type="password"
            class="font-mono text-xs"
            :placeholder="info.token.placeholder"
            spellcheck="false"
            autocomplete="off"
          />
          <p class="text-xs text-muted-foreground">{{ info.token.hint }}</p>
        </div>
        <div v-if="info.token.project" class="space-y-1.5">
          <label for="cloud-project" class="text-sm text-muted-foreground">Project ID <span class="text-xs">(optional)</span></label>
          <Input id="cloud-project" v-model="projectId" class="font-mono text-xs" placeholder="The key's default project" spellcheck="false" />
        </div>
        <div class="space-y-1.5">
          <label for="cloud-label" class="text-sm text-muted-foreground">Name <span class="text-xs">(optional)</span></label>
          <Input id="cloud-label" v-model="label" class="w-72" placeholder="Shown in the Clusters hub" spellcheck="false" />
        </div>
        <button type="submit" class="hidden" />
      </form>

      <!-- Exoscale API key -->
      <form v-else-if="step === 'apiKey'" class="space-y-5" @submit.prevent="keyValid && useApiKey()">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5">
            <label for="exo-key" class="text-sm text-muted-foreground">API key</label>
            <Input id="exo-key" v-model="apiKey.key" class="font-mono text-xs" placeholder="EXO…" spellcheck="false" autocomplete="off" />
          </div>
          <div class="space-y-1.5">
            <label for="exo-secret" class="text-sm text-muted-foreground">Secret</label>
            <Input id="exo-secret" v-model="apiKey.secret" type="password" class="font-mono text-xs" spellcheck="false" autocomplete="off" />
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          Create a key with access to SKS in the
          <button type="button" class="text-link hover:underline" @click="openExternal('https://portal.exoscale.com/iam/api-keys')">
            Exoscale portal</button
          >.
        </p>
        <div class="space-y-1.5">
          <label for="exo-label" class="text-sm text-muted-foreground">Name <span class="text-xs">(optional)</span></label>
          <Input id="exo-label" v-model="label" class="w-72" placeholder="Shown in the Clusters hub" spellcheck="false" />
        </div>
        <div>
          <button type="button" class="text-xs text-muted-foreground hover:text-foreground" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? "Hide" : "Show" }} certificate identity
          </button>
          <div v-if="showAdvanced" class="mt-3 grid gap-4 sm:grid-cols-2">
            <div class="space-y-1.5">
              <label for="exo-user" class="text-sm text-muted-foreground">User</label>
              <Input id="exo-user" v-model="apiKey.user" class="font-mono text-xs" spellcheck="false" />
            </div>
            <div class="space-y-1.5">
              <label for="exo-groups" class="text-sm text-muted-foreground">Groups</label>
              <Input id="exo-groups" v-model="apiKey.groups" class="font-mono text-xs" spellcheck="false" />
            </div>
            <p class="text-xs text-muted-foreground sm:col-span-2">
              JET Pilot asks Exoscale for short-lived client certificates for this user and these groups. The default,
              system:masters, gives full access.
            </p>
          </div>
        </div>
        <button type="submit" class="hidden" />
      </form>

      <!-- Sign in with the CLI -->
      <LoginSessionPanel
        v-else-if="step === 'signin'"
        :state="login.state.value"
        success-detail="checking the account"
        @open-url="(url) => login.openUrl(url)"
      />

      <!-- Projects / subscriptions -->
      <div v-else-if="step === 'scopes'" class="space-y-3">
        <div v-if="scopes === null" class="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" /> Loading your {{ info.scopes?.plural }}…
        </div>
        <template v-else>
          <RadioGroupRoot v-model="scopeMode" :class="WIZARD_LIST" :aria-label="`Which ${info.scopes?.plural}`">
            <ChoiceRow value="all" :title="`Every ${info.scopes?.noun}`" :description="`All ${scopes.length} now, and new ones as they appear`" />
            <ChoiceRow value="some" :title="`Only these ${info.scopes?.plural}`" description="Quicker, and quieter in audit logs" />
          </RadioGroupRoot>
          <div v-if="scopeMode === 'some'" class="space-y-2">
            <Input v-if="scopes.length > 8" v-model="scopeFilter" class="h-8" :placeholder="`Filter ${info.scopes?.plural}`" />
            <div :class="WIZARD_LIST">
              <label v-for="scope in shownScopes" :key="scope.id" :class="[WIZARD_ROW, 'cursor-pointer']">
                <Checkbox
                  :checked="pickedScopes.has(scope.id)"
                  :aria-label="`Use ${scope.name}`"
                  @update:checked="(on: boolean) => (on ? pickedScopes.add(scope.id) : pickedScopes.delete(scope.id))"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium">{{ scope.name }}</span>
                  <span class="block truncate font-mono text-[11px] text-muted-foreground">{{ scope.detail ?? scope.id }}</span>
                </span>
              </label>
            </div>
          </div>
        </template>
      </div>

      <!-- Regions / zones -->
      <div v-else-if="step === 'regions'" class="space-y-3">
        <RadioGroupRoot v-model="regionMode" :class="WIZARD_LIST" :aria-label="`Which ${regionNoun}s`">
          <ChoiceRow value="all" :title="`Every ${regionNoun}`" :description="`All of ${info.name}'s ${regionNoun}s`" />
          <ChoiceRow value="some" :title="`Only these ${regionNoun}s`" description="Quicker" />
        </RadioGroupRoot>
        <div v-if="regionMode === 'some'" class="grid grid-cols-3 gap-1.5">
          <label
            v-for="region in regions"
            :key="region"
            class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 font-mono text-xs transition-colors duration-fast hover:bg-accent/50"
            :class="pickedRegions.has(region) ? 'bg-primary/[0.06]' : ''"
          >
            <Checkbox
              :checked="pickedRegions.has(region)"
              @update:checked="(on: boolean) => (on ? pickedRegions.add(region) : pickedRegions.delete(region))"
            />
            {{ region }}
          </label>
        </div>
      </div>

      <!-- Discover -->
      <CatalogPicker
        v-else-if="step === 'discover'"
        v-model:selected="selected"
        v-model:folder="folder"
        :clusters="found"
        :discovering="discovering"
        :checking="checking"
        :failures="failures"
        :folders="folders"
        :empty-title="`No ${info.product} clusters here`"
        :empty-hint="
          info.scopes
            ? `Try other ${info.scopes.plural}, or check that this account can list ${info.product} clusters.`
            : `Check that the ${info.token?.label.toLowerCase() ?? 'key'} can read Kubernetes clusters.`
        "
      />

      <p v-if="error" :class="[WIZARD_ERROR, 'mt-4']" role="alert">
        <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" /> {{ error }}
      </p>
    </div>

    <WizardFooter>
      <template #start>
        <Button v-if="canGoBack" variant="ghost" class="-ml-2.5" @click="back">
          <ArrowLeft class="h-3.5 w-3.5" /> Back
        </Button>
      </template>

      <Button v-if="step === 'cli'" :disabled="!cli?.signedIn || busy" @click="useCli">
        <Loader2 v-if="busy && cli" class="h-3.5 w-3.5 animate-spin" /> Continue
      </Button>
      <Button v-else-if="step === 'token'" :disabled="!tokenValid || busy" @click="useToken">
        <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Check and continue
      </Button>
      <Button v-else-if="step === 'apiKey'" :disabled="!keyValid || busy" @click="useApiKey">
        <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Check and continue
      </Button>
      <template v-else-if="step === 'signin'">
        <Button v-if="login.state.value.phase === 'failed' || login.state.value.phase === 'cancelled'" @click="login.begin()">
          Retry
        </Button>
      </template>
      <Button
        v-else-if="step === 'scopes'"
        :disabled="busy || scopes === null || (scopeMode === 'some' && !pickedScopes.size)"
        @click="saveScopes"
      >
        <Loader2 v-if="busy && scopes !== null" class="h-3.5 w-3.5 animate-spin" />
        {{ info.regional ? "Continue" : "Find clusters" }}
      </Button>
      <Button v-else-if="step === 'regions'" :disabled="busy || (regionMode === 'some' && !pickedRegions.size)" @click="saveRegions">
        <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Find clusters
      </Button>
      <template v-else-if="step === 'discover'">
        <Button variant="ghost" :disabled="discovering" @click="emit('done', [])">Not now</Button>
        <Button :disabled="!chosen.length || busy" @click="addClusters">
          <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
          Add {{ chosen.length }} {{ chosen.length === 1 ? "cluster" : "clusters" }}
        </Button>
      </template>
    </WizardFooter>
  </div>
</template>
