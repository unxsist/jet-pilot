<script setup lang="ts">
/*
 * Connect AWS and add EKS clusters: sign in with IAM Identity Center (a
 * device code, natively), use a profile from ~/.aws, or access keys; pick
 * the accounts and roles, the regions, then the clusters. Clusters you don't
 * add stay available in the Clusters hub, and the account keeps them current.
 *
 * With `connectionId`, edits an existing account (accounts, regions).
 */
import { invoke } from "@tauri-apps/api/core";
import { RadioGroupRoot } from "radix-vue";
import {
  ArrowLeft,
  Building2,
  ChevronRight,
  CircleAlert,
  FileKey2,
  KeyRound,
  Loader2,
  Search,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import LoginSessionPanel from "@/components/auth/LoginSessionPanel.vue";
import MfaCode from "./MfaCode.vue";
import ChoiceRow from "@/components/wizard/ChoiceRow.vue";
import WizardFooter from "@/components/wizard/WizardFooter.vue";
import { WIZARD_BODY, WIZARD_ERROR, WIZARD_GROUP_LABEL, WIZARD_LIST, WIZARD_ROW } from "@/components/wizard/wizard";
import { useLoginSession } from "@/lib/auth/useLoginSession";
import { useClusters } from "@/lib/clusters/useClusters";
import { discoverKubeconfigs } from "@/lib/kubeconfigSources";
import { errorMessage, withVault } from "@/lib/clusters/managed";
import {
  awsMfaSignIn,
  awsProfiles,
  awsRegions,
  awsSsoAccounts,
  awsSsoSignIn,
  catalogAdd,
  createConnection,
  deleteConnection,
  listConnections,
  updateConnection,
  type AwsAccount,
  type AwsProfile,
  type CatalogCluster,
  type CloudConnection,
  type ConnectionTarget,
} from "@/lib/clusters/cloud";
import {
  catalogWhere,
  defaultRole,
  discoverySummary,
  failureGroups,
  failureSummary,
  knownPortals,
  parseStartUrl,
  portalName,
  type DiscoveryScope,
} from "@/lib/clusters/cloudModel";
import { catalog, discovery, refreshCloud } from "@/lib/clusters/catalogStore";
import type { ContextRef } from "@/lib/contextKey";

const props = defineProps<{ connectionId?: string | null; folders?: string[] }>();
const emit = defineEmits<{ back: []; done: [added: ContextRef[]]; heading: [heading: { title: string; description: string }] }>();

const clusters = useClusters();

type Step = "method" | "sso" | "profile" | "keys" | "signin" | "mfa" | "accounts" | "regions" | "discover";
const step = ref<Step>("method");
const history = reactive<Step[]>([]);
const go = (next: Step) => {
  history.push(step.value);
  step.value = next;
  error.value = null;
};
/* Leaves a sign-in behind: Back from the next step goes to the form, not the finished sign-in. */
const replace = (next: Step) => {
  if (step.value !== "signin" && step.value !== "mfa") history.push(step.value);
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

const profiles = ref<AwsProfile[] | null>(null);
const regions = ref<string[]>([]);
onMounted(async () => {
  [profiles.value, regions.value] = await Promise.all([
    awsProfiles().catch(() => [] as AwsProfile[]),
    awsRegions().catch(() => [] as string[]),
  ]);
  const portal = knownPortals(profiles.value)[0];
  if (portal && !startUrl.value) {
    startUrl.value = portal.startUrl;
    if (portal.region) ssoRegion.value = portal.region;
  }
});

/* ------------------------------------------------------ IAM Identity Center -- */

const startUrl = ref("");
const ssoRegion = ref("us-east-1");
const label = ref("");
const parsedUrl = computed(() => parseStartUrl(startUrl.value));
const portals = computed(() => knownPortals(profiles.value ?? []));

const login = useLoginSession(
  {
    start: (channel) => withVault(() => awsSsoSignIn(connection.value!.id, channel)),
    cancel: (sessionId) => invoke("auth_login_cancel", { sessionId }),
    openUrl: (sessionId, url) => invoke("auth_login_open_url", { sessionId, url }),
  },
  (finished) => {
    if (finished.phase !== "succeeded") return;
    setTimeout(() => {
      if (step.value !== "signin") return;
      if (connection.value?.kind === "sso") void loadAccounts();
      else replace("regions");
    }, 700);
  }
);

const signIn = () =>
  run(async () => {
    const url = parsedUrl.value;
    if (!url) throw new Error("Enter your AWS access portal URL, e.g. https://acme.awsapps.com/start");
    const current = connection.value;
    if (!current || current.kind !== "sso" || current.sso?.startUrl !== url || current.sso.region !== ssoRegion.value) {
      await replaceConnection(() =>
        createConnection({ kind: "sso", label: label.value.trim() || undefined, startUrl: url, region: ssoRegion.value })
      );
    }
    go("signin");
    login.begin();
  });

/* -------------------------------------------------------------- profile -- */

const profileName = ref<string | null>(null);
const PROFILE_KINDS: Record<AwsProfile["kind"], string> = {
  sso: "IAM Identity Center",
  assumeRole: "Assumes a role",
  static: "Access keys",
  credentialProcess: "Credential process",
  webIdentity: "Web identity",
  unknown: "Other",
};
const useProfile = () =>
  run(async () => {
    const profile = profiles.value?.find((p) => p.name === profileName.value);
    if (!profile) return;
    await replaceConnection(() => createConnection({ kind: "profile", profile: profile.name }));
    const created = connection.value!;
    if (created.status === "signedIn") go("regions");
    else if (profile.mfa) go("mfa");
    else if (profile.kind === "sso") {
      go("signin");
      login.begin();
    } else throw new Error(created.message ?? "These credentials don't work.");
  });

const mfaCode = ref("");
const enterMfa = (code: string) =>
  run(async () => {
    connection.value = await awsMfaSignIn(connection.value!.id, code);
    replace("regions");
  });

/* ------------------------------------------------------------------ keys -- */

const keys = reactive({ accessKeyId: "", secretAccessKey: "", sessionToken: "", region: "us-east-1" });
const keysValid = computed(() => /^(AKIA|ASIA)[A-Z0-9]{12,}$/.test(keys.accessKeyId.trim()) && keys.secretAccessKey.trim().length >= 20);
const useKeys = () =>
  run(async () => {
    await replaceConnection(() =>
      withVault(() =>
        createConnection({
          kind: "keys",
          label: label.value.trim() || undefined,
          accessKeyId: keys.accessKeyId.trim(),
          secretAccessKey: keys.secretAccessKey.trim(),
          sessionToken: keys.sessionToken.trim() || undefined,
          region: keys.region,
        })
      )
    );
    if (connection.value!.status !== "signedIn") throw new Error(connection.value!.message ?? "AWS didn't accept these keys.");
    keys.secretAccessKey = "";
    keys.sessionToken = "";
    go("regions");
  });

/* -------------------------------------------------------------- accounts -- */

const accounts = ref<AwsAccount[] | null>(null);
const picks = reactive(new Map<string, { include: boolean; role: string | null }>());
const accountFilter = ref("");

const loadAccounts = () =>
  run(async () => {
    if (step.value !== "accounts") replace("accounts");
    accounts.value = null;
    const list = await awsSsoAccounts(connection.value!.id);
    list.sort((a, b) => a.accountName.localeCompare(b.accountName));
    const existing = new Map((connection.value!.targets ?? []).map((t) => [t.accountId, t.roleName]));
    const chosen = [...existing.values()];
    picks.clear();
    for (const account of list) {
      const role = existing.get(account.accountId);
      picks.set(account.accountId, {
        include: existing.size ? existing.has(account.accountId) : true,
        role: role && account.roles.includes(role) ? role : defaultRole(account.roles, chosen),
      });
    }
    accounts.value = list;
  });

const shownAccounts = computed(() => {
  const words = accountFilter.value.trim().toLowerCase();
  return (accounts.value ?? []).filter(
    (a) => !words || a.accountName.toLowerCase().includes(words) || a.accountId.includes(words) || a.email?.toLowerCase().includes(words)
  );
});
const includedAccounts = computed(() => (accounts.value ?? []).filter((a) => picks.get(a.accountId)?.include));
const allRoles = computed(() => [...new Set((accounts.value ?? []).flatMap((a) => a.roles))].sort());
const setAll = (include: boolean) => shownAccounts.value.forEach((a) => (picks.get(a.accountId)!.include = include));
const roleForAll = (role: string) => {
  for (const account of accounts.value ?? []) if (account.roles.includes(role)) picks.get(account.accountId)!.role = role;
};

const saveAccounts = () =>
  run(async () => {
    const targets: ConnectionTarget[] = includedAccounts.value.map((a) => ({
      accountId: a.accountId,
      accountName: a.accountName,
      roleName: picks.get(a.accountId)!.role!,
    }));
    connection.value = await updateConnection(connection.value!.id, { targets });
    go("regions");
  });

/* --------------------------------------------------------------- regions -- */

const regionMode = ref<"all" | "some">("all");
const pickedRegions = reactive(new Set<string>());
const AREAS: Record<string, string> = {
  us: "United States",
  ca: "Canada",
  mx: "Mexico",
  sa: "South America",
  eu: "Europe",
  il: "Israel",
  me: "Middle East",
  af: "Africa",
  ap: "Asia Pacific",
};
const regionAreas = computed(() => {
  const areas = new Map<string, string[]>();
  for (const region of regions.value) {
    const area = AREAS[region.split("-")[0]!] ?? "Other";
    areas.set(area, [...(areas.get(area) ?? []), region]);
  }
  return [...areas.entries()];
});
watch(step, (current) => {
  if (current !== "regions" || !connection.value) return;
  const saved = connection.value.regions;
  regionMode.value = saved.length ? "some" : "all";
  pickedRegions.clear();
  saved.forEach((r) => pickedRegions.add(r));
});

/* ------------------------------------------------------------- discover -- */

const found = computed<CatalogCluster[]>(() => {
  const id = connection.value?.id;
  const live = discovery.value?.clusters ?? catalog.value ?? [];
  return live
    .filter((c) => c.connectionId === id)
    .sort((a, b) => catalogWhere(a).localeCompare(catalogWhere(b)) || a.name.localeCompare(b.name));
});
const progress = computed(() => (discovery.value ? discoverySummary(discovery.value) : null));
/* What's being looked at right now: "acme-staging · eu-north-1". */
const checking = computed(() => {
  const running = discovery.value?.scopes.filter((s) => s.state === "running") ?? [];
  const latest = running[running.length - 1];
  return !latest ? null : latest.scope === "regions" ? "the enabled regions" : latest.scope;
});
const lastFailures = shallowRef<DiscoveryScope[]>([]);
const failures = computed(() => failureGroups(discovery.value?.scopes.filter((s) => s.state === "error") ?? lastFailures.value));
const discovering = computed(() => !!discovery.value);
const showFailures = ref(false);
const selection = reactive(new Set<string>());
const folder = ref("");

/* New clusters are selected as they turn up (not ones already added or ignored). */
watch(found, (list, previous) => {
  const before = new Set((previous ?? []).map((c) => c.key));
  for (const cluster of list) if (!before.has(cluster.key) && cluster.state === "available") selection.add(cluster.key);
});

const findClusters = async () => {
  const id = connection.value!.id;
  await run(async () => {
    connection.value = await updateConnection(id, { regions: regionMode.value === "all" ? [] : [...pickedRegions].sort() });
  });
  if (error.value) return;
  kept = true;
  folder.value ||= connection.value!.label;
  selection.clear();
  go("discover");
  try {
    const finished = await refreshCloud([id]);
    lastFailures.value = finished.scopes.filter((s) => s.state === "error");
  } catch (e) {
    error.value = errorMessage(e);
  }
};

const selectable = computed(() => found.value.filter((c) => c.state !== "added" && c.state !== "removed"));
const chosen = computed(() => selectable.value.filter((c) => selection.has(c.key)));

const addClusters = () =>
  run(async () => {
    const result = await withVault(() => catalogAdd(chosen.value.map((c) => c.key), folder.value.trim() || null));
    if (folder.value.trim()) clusters.updateMany(result.added, { folder: folder.value.trim() });
    void discoverKubeconfigs(true);
    if (result.failed.length && !result.added.length) {
      throw new Error(result.failed.map((f) => f.message).join("\n"));
    }
    emit("done", result.added);
  });

const EKS_STATUS: Record<string, string> = {
  ACTIVE: "Active",
  CREATING: "Creating",
  UPDATING: "Updating",
  DELETING: "Deleting",
  FAILED: "Failed",
  PENDING: "Pending",
};

/* ----------------------------------------------------------------- setup -- */

onMounted(async () => {
  if (!props.connectionId) return;
  await run(async () => {
    const existing = (await listConnections()).find((c) => c.id === props.connectionId);
    if (!existing) throw new Error("This account was removed.");
    connection.value = existing;
    if (existing.kind === "sso") {
      if (existing.status === "signedIn") await loadAccounts();
      else {
        step.value = "signin";
        login.begin();
      }
    } else if (existing.kind === "profile" && existing.status !== "signedIn") {
      const profile = (await awsProfiles().catch(() => [] as AwsProfile[])).find((p) => p.name === existing.profile);
      if (profile?.mfa) step.value = "mfa";
      else {
        step.value = "signin";
        login.begin();
      }
    } else step.value = "regions";
    history.length = 0;
  });
});

/* Editing an account starts at its first step: nothing to go back to. */
const canGoBack = computed(() => !(props.connectionId && !history.length && step.value !== "method"));

const where = computed(() => connection.value?.sso?.startUrl?.replace(/^https?:\/\//, "") ?? connection.value?.profile ?? "");
const headings: Record<Step, () => [string, string]> = {
  method: () => ["Connect AWS", "JET Pilot finds the EKS clusters in your accounts and keeps the list current."],
  sso: () => ["Sign in with IAM Identity Center", "You'll get a code to enter in your browser."],
  profile: () => ["Use an AWS profile", "From ~/.aws/config, the way the aws CLI uses it."],
  keys: () => ["Use access keys", "An IAM user's keys, kept in your system keychain."],
  signin: () => ["Sign in to AWS", where.value],
  mfa: () => ["Multi-factor authentication", `The ${connection.value?.profile ?? ""} profile assumes a role that needs one.`],
  accounts: () => ["Choose accounts and roles", "The role decides what you can do in each cluster."],
  regions: () => [
    "Where to look for clusters",
    props.connectionId ? "JET Pilot looks for EKS clusters in these regions." : "You can change this later in the account's menu.",
  ],
  discover: () => [
    discovering.value
      ? "Looking for EKS clusters…"
      : `${found.value.length} EKS ${found.value.length === 1 ? "cluster" : "clusters"} found`,
    "Clusters you don't add stay available in the Clusters hub.",
  ],
};
watch(
  () => headings[step.value](),
  ([title, description]) => emit("heading", { title, description }),
  { immediate: true }
);

const METHODS = [
  { step: "sso", icon: Building2, title: "IAM Identity Center", text: "Your organisation's AWS access portal", recommended: true },
  { step: "profile", icon: FileKey2, title: "An AWS profile", text: "A profile from ~/.aws/config", recommended: false },
  { step: "keys", icon: KeyRound, title: "Access keys", text: "An IAM user's access key and secret", recommended: false },
] as const;
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div :class="WIZARD_BODY">
      <!-- Method -->
      <div v-if="step === 'method'" :class="WIZARD_LIST">
        <button
          v-for="option in METHODS"
          :key="option.step"
          type="button"
          class="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-fast hover:bg-accent/50 focus-ring"
          @click="go(option.step)"
        >
          <span
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors duration-fast group-hover:text-foreground"
          >
            <component :is="option.icon" class="h-4 w-4" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2 text-sm font-medium text-foreground">
              {{ option.title }}
              <span v-if="option.recommended" class="text-xs font-normal text-link">Recommended</span>
            </span>
            <span class="block truncate text-xs text-muted-foreground">{{ option.text }}</span>
          </span>
          <ChevronRight
            class="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover:opacity-100"
          />
        </button>
      </div>

      <!-- IAM Identity Center -->
      <form
        v-else-if="step === 'sso'"
        class="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-4 gap-y-4"
        @submit.prevent="signIn"
      >
        <label for="aws-start-url" class="pt-1.5 text-sm text-muted-foreground">Access portal</label>
        <div class="space-y-2">
          <Input
            id="aws-start-url"
            v-model="startUrl"
            class="font-mono text-xs"
            placeholder="https://acme.awsapps.com/start"
            spellcheck="false"
            autocomplete="off"
          />
          <p class="text-xs text-muted-foreground">
            <template v-if="parsedUrl && parsedUrl !== startUrl.trim()">
              Signs in at <span class="font-mono text-[11px] text-foreground/80">{{ parsedUrl }}</span>
            </template>
            <template v-else>Its start URL, or just its name.</template>
          </p>
          <div v-if="portals.length" class="flex flex-wrap items-center gap-1.5">
            <span class="text-xs text-muted-foreground">From ~/.aws/config</span>
            <button
              v-for="portal in portals.slice(0, 3)"
              :key="portal.startUrl"
              type="button"
              class="rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors duration-fast focus-ring"
              :class="portal.startUrl === parsedUrl ? 'bg-primary/10 text-link' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'"
              @click="startUrl = portal.startUrl; portal.region && (ssoRegion = portal.region)"
            >
              {{ portalName(portal.startUrl) }}
            </button>
          </div>
        </div>

        <label for="aws-sso-region" class="pt-1.5 text-sm text-muted-foreground">Region</label>
        <div class="space-y-1.5">
          <Select v-model="ssoRegion">
            <SelectTrigger id="aws-sso-region" class="w-56 font-mono text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="region in regions.length ? regions : [ssoRegion]" :key="region" :value="region" class="font-mono text-xs">
                {{ region }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">Where IAM Identity Center is set up.</p>
        </div>

        <label for="aws-label" class="pt-1.5 text-sm text-muted-foreground">Name</label>
        <div class="space-y-1.5">
          <Input id="aws-label" v-model="label" class="w-64" :placeholder="parsedUrl ? portalName(parsedUrl) : 'acme'" spellcheck="false" />
          <p class="text-xs text-muted-foreground">Optional. How the account shows in JET Pilot.</p>
        </div>
        <span />
        <p class="text-xs text-muted-foreground">The aws CLI can use this sign-in too.</p>
        <button type="submit" class="hidden" />
      </form>

      <!-- Profile -->
      <template v-else-if="step === 'profile'">
        <div v-if="profiles === null" class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" /> Reading ~/.aws/config…
        </div>
        <p v-else-if="!profiles.length" class="rounded-xl bg-muted/50 px-4 py-8 text-center text-sm text-muted-foreground">
          There are no profiles in ~/.aws/config or ~/.aws/credentials.
        </p>
        <RadioGroupRoot
          v-else
          :model-value="profileName ?? undefined"
          :class="[WIZARD_LIST, 'space-y-px']"
          aria-label="AWS profiles"
          @update:model-value="(name: string) => (profileName = name)"
        >
          <ChoiceRow v-for="profile in profiles" :key="profile.name" :value="profile.name" :title="profile.name">
            <template #description>
              {{ PROFILE_KINDS[profile.kind] }}<template v-if="profile.ssoStartUrl"> · {{ portalName(profile.ssoStartUrl) }}</template><template v-if="profile.region"> · {{ profile.region }}</template>
            </template>
            <template v-if="profile.mfa" #end>
              <span class="mt-0.5 shrink-0 text-xs text-muted-foreground" title="Asks for a code from your MFA device">MFA</span>
            </template>
          </ChoiceRow>
        </RadioGroupRoot>
      </template>

      <!-- Access keys -->
      <form
        v-else-if="step === 'keys'"
        class="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-4 gap-y-4"
        @submit.prevent="keysValid && useKeys()"
      >
        <label for="aws-key-id" class="pt-1.5 text-sm text-muted-foreground">Access key ID</label>
        <Input id="aws-key-id" v-model="keys.accessKeyId" class="font-mono text-xs" placeholder="AKIA…" spellcheck="false" autocomplete="off" />
        <label for="aws-secret" class="pt-1.5 text-sm text-muted-foreground">Secret</label>
        <Input
          id="aws-secret"
          v-model="keys.secretAccessKey"
          type="password"
          class="font-mono text-xs"
          aria-label="Secret access key"
          spellcheck="false"
          autocomplete="off"
        />
        <label for="aws-session-token" class="pt-1.5 text-sm text-muted-foreground">Session token</label>
        <Input
          id="aws-session-token"
          v-model="keys.sessionToken"
          type="password"
          class="font-mono text-xs"
          placeholder="Optional"
          spellcheck="false"
          autocomplete="off"
        />
        <label for="aws-key-region" class="pt-1.5 text-sm text-muted-foreground">Region</label>
        <Select v-model="keys.region">
          <SelectTrigger id="aws-key-region" class="w-56 font-mono text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="region in regions.length ? regions : [keys.region]" :key="region" :value="region" class="font-mono text-xs">
              {{ region }}
            </SelectItem>
          </SelectContent>
        </Select>
        <label for="aws-keys-label" class="pt-1.5 text-sm text-muted-foreground">Name</label>
        <Input id="aws-keys-label" v-model="label" class="w-64" placeholder="Optional, e.g. ci-readonly" spellcheck="false" />
        <span />
        <p class="text-xs text-muted-foreground">
          Needs <span class="font-mono text-[11px]">eks:ListClusters</span> and
          <span class="font-mono text-[11px]">eks:DescribeCluster</span>, plus access to the clusters. Never written to a
          kubeconfig.
        </p>
        <button type="submit" class="hidden" />
      </form>

      <!-- Sign in -->
      <LoginSessionPanel
        v-else-if="step === 'signin'"
        :state="login.state.value"
        :success-detail="connection?.kind === 'sso' ? 'Loading your accounts…' : undefined"
        @open-url="(url) => login.openUrl(url)"
      />

      <!-- MFA -->
      <MfaCode v-else-if="step === 'mfa'" v-model="mfaCode" :profile="connection?.profile ?? ''" @submit="enterMfa" />

      <!-- Accounts -->
      <template v-else-if="step === 'accounts'">
        <div v-if="accounts === null" class="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" /> Loading the accounts you can use…
        </div>
        <template v-else>
          <div v-if="accounts.length > 6" class="relative mb-2">
            <Search class="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              v-model="accountFilter"
              class="h-9 w-full rounded-lg border border-transparent bg-muted/60 pl-9 pr-3 text-sm outline-none transition-[border-color,box-shadow,background-color] duration-fast placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/20"
              placeholder="Filter accounts"
              aria-label="Filter accounts"
            />
          </div>
          <div :class="WIZARD_LIST">
            <div class="sticky top-0 z-10 flex h-9 items-center gap-3 bg-popover px-3 text-xs text-muted-foreground">
              <Checkbox
                :checked="shownAccounts.every((a) => picks.get(a.accountId)?.include) ? true : shownAccounts.some((a) => picks.get(a.accountId)?.include) ? 'indeterminate' : false"
                aria-label="Select all accounts"
                @update:checked="(on: boolean) => setAll(on)"
              />
              <span class="flex-1 tabular-nums">{{ includedAccounts.length }} of {{ accounts.length }} accounts</span>
              <Select v-if="allRoles.length > 1" @update:model-value="(role) => roleForAll(String(role))">
                <SelectTrigger
                  class="h-7 w-auto gap-1 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:border-transparent hover:bg-accent hover:text-foreground"
                  aria-label="Use one role for every account"
                >
                  <span>Same role for all</span>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem v-for="role in allRoles" :key="role" :value="role" class="text-xs">{{ role }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label v-for="account in shownAccounts" :key="account.accountId" :class="[WIZARD_ROW, 'cursor-pointer']">
              <Checkbox
                :checked="picks.get(account.accountId)?.include"
                :aria-label="`Use ${account.accountName}`"
                @update:checked="(on: boolean) => (picks.get(account.accountId)!.include = on)"
              />
              <span class="min-w-0 flex-1" :class="picks.get(account.accountId)?.include ? '' : 'opacity-60'">
                <span class="block truncate text-sm font-medium">{{ account.accountName }}</span>
                <span class="block truncate text-xs text-muted-foreground">
                  <span class="font-mono text-[11px]">{{ account.accountId }}</span><template v-if="account.email"> · {{ account.email }}</template>
                </span>
              </span>
              <Select
                :model-value="picks.get(account.accountId)?.role ?? undefined"
                :disabled="!picks.get(account.accountId)?.include"
                @update:model-value="(role) => (picks.get(account.accountId)!.role = String(role))"
              >
                <SelectTrigger
                  class="h-7 w-auto max-w-[13rem] gap-1 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:border-transparent hover:bg-accent hover:text-foreground"
                  :aria-label="`Role in ${account.accountName}`"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem v-for="role in account.roles" :key="role" :value="role" class="text-xs">{{ role }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
        </template>
      </template>

      <!-- Regions -->
      <template v-else-if="step === 'regions'">
        <RadioGroupRoot v-model="regionMode" :class="[WIZARD_LIST, 'space-y-px']" aria-label="Regions">
          <ChoiceRow
            value="all"
            title="Every region enabled in the account"
            description="Finds clusters wherever they are; the first look takes a little longer."
          />
          <ChoiceRow value="some" title="Only these regions" description="Faster, and quieter in CloudTrail.">
            <template v-if="regionMode === 'some'" #end>
              <span class="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground">{{ pickedRegions.size }} selected</span>
            </template>
          </ChoiceRow>
        </RadioGroupRoot>
        <div v-if="regionMode === 'some'" class="mt-3 space-y-4 pl-7">
          <div v-for="[area, list] in regionAreas" :key="area" class="space-y-1">
            <p :class="WIZARD_GROUP_LABEL">{{ area }}</p>
            <div class="-mx-2 grid grid-cols-3 gap-x-1">
              <label
                v-for="region in list"
                :key="region"
                class="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 font-mono text-xs transition-colors duration-fast hover:bg-accent/50"
                :class="pickedRegions.has(region) ? 'text-foreground' : 'text-muted-foreground'"
              >
                <Checkbox
                  :checked="pickedRegions.has(region)"
                  @update:checked="(on: boolean) => (on ? pickedRegions.add(region) : pickedRegions.delete(region))"
                />
                {{ region }}
              </label>
            </div>
          </div>
        </div>
      </template>

      <!-- Discover -->
      <template v-else-if="step === 'discover'">
        <div
          v-if="discovering && progress"
          class="mb-3 flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span class="truncate">
            <template v-if="checking">Checking {{ checking }} · </template>
            {{ progress.found }} {{ progress.found === 1 ? "cluster" : "clusters" }} so far
          </span>
        </div>

        <div v-if="found.length" :class="WIZARD_LIST">
          <label
            v-if="selectable.length > 1"
            class="sticky top-0 z-10 flex h-9 cursor-pointer items-center gap-3 bg-popover px-3 text-xs text-muted-foreground"
          >
            <Checkbox
              :checked="chosen.length === selectable.length ? true : chosen.length ? 'indeterminate' : false"
              aria-label="Select all clusters"
              @update:checked="(on: boolean) => (selection.clear(), on && selectable.forEach((c) => selection.add(c.key)))"
            />
            <span class="tabular-nums">{{ chosen.length }} of {{ selectable.length }} selected</span>
          </label>
          <label
            v-for="cluster in found"
            :key="cluster.key"
            :class="[WIZARD_ROW, cluster.state === 'added' || cluster.state === 'removed' ? 'hover:bg-transparent' : 'cursor-pointer']"
          >
            <Checkbox
              :checked="cluster.state === 'added' || selection.has(cluster.key)"
              :disabled="cluster.state === 'added' || cluster.state === 'removed'"
              :aria-label="`Add ${cluster.name}`"
              @update:checked="(on: boolean) => (on ? selection.add(cluster.key) : selection.delete(cluster.key))"
            />
            <span class="min-w-0 flex-1" :class="cluster.state === 'added' ? 'opacity-60' : ''">
              <span class="block truncate text-sm font-medium">{{ cluster.name }}</span>
              <span class="block truncate text-xs text-muted-foreground">{{ catalogWhere(cluster) }}</span>
            </span>
            <span v-if="cluster.state === 'added'" class="text-xs text-muted-foreground">Already added</span>
            <span v-else-if="cluster.state === 'ignored'" class="text-xs text-muted-foreground">Ignored</span>
            <span v-else-if="cluster.status && cluster.status !== 'ACTIVE'" class="flex items-center gap-1.5 text-xs text-warning">
              <span class="h-1.5 w-1.5 rounded-full bg-current" /> {{ EKS_STATUS[cluster.status] ?? cluster.status }}
            </span>
            <span v-else-if="cluster.version" class="font-mono text-xs tabular-nums text-muted-foreground">v{{ cluster.version }}</span>
          </label>
        </div>
        <div v-else-if="!discovering" class="rounded-xl bg-muted/50 px-6 py-8 text-center">
          <p class="text-sm font-medium">No EKS clusters here</p>
          <p class="mt-1 text-xs text-muted-foreground">
            The role needs <span class="font-mono text-[11px]">eks:ListClusters</span> and
            <span class="font-mono text-[11px]">eks:DescribeCluster</span>. Try other accounts, a different role or more
            regions.
          </p>
        </div>

        <div v-if="failures.length" class="mt-4 text-xs">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-sm text-warning focus-ring"
            :aria-expanded="showFailures"
            @click="showFailures = !showFailures"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-current" />
            {{ failureSummary(failures) }}
            <ChevronRight class="h-3.5 w-3.5 text-muted-foreground transition-transform duration-fast" :class="showFailures ? 'rotate-90' : ''" />
          </button>
          <ul v-if="showFailures" class="mt-2 space-y-1 pl-3 text-muted-foreground">
            <li v-for="group in failures" :key="group.account">
              <span class="font-medium text-foreground">{{ group.account }}</span>
              <template v-if="group.regions.length"> ({{ group.regions.join(", ") }})</template>: {{ group.message }}
            </li>
          </ul>
        </div>

        <div v-if="selectable.length" class="mt-5 flex items-center gap-3">
          <label for="aws-folder" class="text-sm text-muted-foreground">Folder</label>
          <Input id="aws-folder" v-model="folder" class="h-8 w-60" list="aws-folders" placeholder="No folder" spellcheck="false" />
          <datalist id="aws-folders">
            <option v-for="name in folders ?? []" :key="name" :value="name" />
          </datalist>
        </div>
      </template>

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

      <Button v-if="step === 'sso'" :disabled="!parsedUrl || busy" @click="signIn">
        <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Sign in
      </Button>
      <Button v-else-if="step === 'profile'" :disabled="!profileName || busy" @click="useProfile">
        <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Continue
      </Button>
      <Button v-else-if="step === 'keys'" :disabled="!keysValid || busy" @click="useKeys">
        <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Check and continue
      </Button>
      <template v-else-if="step === 'signin'">
        <Button v-if="login.state.value.phase === 'failed' || login.state.value.phase === 'cancelled'" @click="login.begin()">
          Retry
        </Button>
        <Button v-else-if="!canGoBack && login.state.value.phase !== 'succeeded'" variant="ghost" @click="emit('done', [])">
          Cancel
        </Button>
      </template>
      <Button v-else-if="step === 'mfa'" :disabled="mfaCode.length !== 6 || busy" @click="enterMfa(mfaCode)">
        <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Continue
      </Button>
      <Button v-else-if="step === 'accounts'" :disabled="!includedAccounts.length || busy || accounts === null" @click="saveAccounts">
        <Loader2 v-if="busy && accounts !== null" class="h-3.5 w-3.5 animate-spin" />
        Continue with {{ includedAccounts.length }} {{ includedAccounts.length === 1 ? "account" : "accounts" }}
      </Button>
      <Button v-else-if="step === 'regions'" :disabled="busy || (regionMode === 'some' && !pickedRegions.size)" @click="findClusters">
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
