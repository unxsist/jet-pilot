<script setup lang="ts">
/*
 * Add a cluster: connect a cloud account (AwsConnect), paste (or drop) a
 * kubeconfig, import a kubeconfig file, or enter a cluster by hand. Added
 * clusters go into JET Pilot's own kubeconfig (~/.kube/jet-pilot/config)
 * with their credentials in the system keychain; a file can also be used
 * where it is. One wizard: a header with the step's context, a calm body,
 * Back on the left and one primary on the right.
 */
import { useRouter } from "vue-router";
import { homeDir, join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  ClipboardPaste,
  FileUp,
  Loader2,
  PencilLine,
  Terminal,
  TriangleAlert,
} from "lucide-vue-next";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ClusterLabel from "@/components/clusters/ClusterLabel.vue";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import ImportPreview from "./ImportPreview.vue";
import ManualEntry from "./ManualEntry.vue";
import WizardHeader from "@/components/wizard/WizardHeader.vue";
import WizardFooter from "@/components/wizard/WizardFooter.vue";
import { WIZARD_BODY, WIZARD_DIALOG, WIZARD_ERROR, WIZARD_GROUP_LABEL, WIZARD_LIST } from "@/components/wizard/wizard";
import { emptyManualForm, toSpec, type ImportRow, type ManualForm } from "./forms";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { KubeContextSwitchContextKey } from "@/providers/KubeContextProvider";
import { normalizeKubeconfigPath, discoverKubeconfigs } from "@/lib/kubeconfigSources";
import {
  addManualCluster,
  commitImport,
  errorMessage,
  previewImport,
  withVault,
  type AddMethod,
  type ImportSource,
} from "@/lib/clusters/managed";
import type { ContextRef } from "@/lib/contextKey";
import type { CloudProvider } from "@/lib/clusters/cloud";
import { CLOUD_PROVIDERS, providerInfo } from "@/lib/clusters/providers";

const AwsConnect = defineAsyncComponent(() => import("./AwsConnect.vue"));
const CloudConnect = defineAsyncComponent(() => import("./CloudConnect.vue"));

const props = defineProps<{ method: AddMethod; provider?: CloudProvider | null; connectionId?: string | null }>();
const open = defineModel<boolean>("open", { required: true });

const router = useRouter();
const { settings } = injectStrict(SettingsContextStateKey);
const switchContext = injectStrict(KubeContextSwitchContextKey);

type Step = "choose" | "paste" | "file" | "preview" | "manual" | "cloud" | "done";
const step = ref<Step>("choose");
const history: Step[] = [];
const go = (next: Step) => {
  history.push(step.value);
  step.value = next;
  error.value = null;
};
const back = () => {
  step.value = history.pop() ?? "choose";
  error.value = null;
};

const busy = ref(false);
const error = ref<string | null>(null);

/* ----------------------------------------------------- import (paste/file) -- */

const pasted = ref("");
const source = ref<ImportSource | null>(null);
const previewId = ref("");
const rows = ref<ImportRow[]>([]);
const trusted = ref(false);
/* A picked file: copy it into JET Pilot, or keep using it where it is. */
const fileMode = ref<"copy" | "reference">("copy");

const loadPreview = async (next: ImportSource) => {
  busy.value = true;
  error.value = null;
  try {
    const preview = await previewImport(next);
    if (!preview.contexts.length) {
      error.value = "This kubeconfig has no contexts.";
      return;
    }
    source.value = next;
    previewId.value = preview.previewId;
    trusted.value = false;
    rows.value = preview.contexts.map((context) => ({
      context,
      include: !context.duplicateOf,
      name: context.nameConflict ? context.suggestedName : context.name,
    }));
    if (step.value !== "preview") go("preview");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
};

const pickFile = async () => {
  const path = await openDialog({
    multiple: false,
    title: "Import a kubeconfig file",
    defaultPath: await join(await homeDir(), ".kube"),
  });
  if (!path || Array.isArray(path)) return;
  fileMode.value = "copy";
  await loadPreview({ kind: "path", path });
};

const included = computed(() => rows.value.filter((row) => row.include));
const needsTrust = computed(() => included.value.some((row) => row.context.execCommand));
const referencing = computed(() => source.value?.kind === "path" && fileMode.value === "reference");
const canImport = computed(
  () =>
    referencing.value ||
    (included.value.length > 0 && included.value.every((row) => row.name.trim()) && (!needsTrust.value || trusted.value))
);
const sourcePath = computed(() =>
  source.value?.kind === "path" ? source.value.path.replace(/^\/(home|Users)\/[^/]+/, "~") : null
);

const added = ref<ContextRef[]>([]);

const runImport = async () => {
  if (!source.value) return;
  busy.value = true;
  error.value = null;
  try {
    if (source.value.kind === "path" && fileMode.value === "reference") {
      const path = source.value.path;
      const key = normalizeKubeconfigPath(path);
      if (!settings.value.kubeconfig.sources.some((s) => normalizeKubeconfigPath(s) === key)) {
        settings.value.kubeconfig.sources.push(path);
      }
      added.value = rows.value.map((row) => ({ context: row.context.name, kubeConfig: path }));
    } else {
      const result = await withVault(() =>
        commitImport(
          previewId.value,
          rows.value.map((row) => ({
            context: row.context.name,
            include: row.include,
            rename: row.name.trim() !== row.context.name ? row.name.trim() : null,
          }))
        )
      );
      added.value = result.added;
      void discoverKubeconfigs(true);
    }
    go("done");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
};

/* ------------------------------------------------------------- manual -- */

const manual = ref<ManualForm>(emptyManualForm());
const manualValid = ref(false);
const runManual = async () => {
  busy.value = true;
  error.value = null;
  try {
    const target = await withVault(() => addManualCluster(toSpec(manual.value)));
    added.value = [target];
    void discoverKubeconfigs(true);
    go("done");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
};

/* -------------------------------------------------------------- cloud -- */

const cloudHeading = ref<{ title: string; description: string }>({ title: "Connect a cloud", description: "" });
const cloudProvider = ref<CloudProvider>("aws");
const chooseCloud = (provider: CloudProvider) => {
  cloudProvider.value = provider;
  cloudHeading.value = { title: `Connect ${providerInfo(provider).name}`, description: "" };
  go("cloud");
};
/* Added, with something to know (e.g. a sign-in plugin that isn't installed). */
const warnings = ref<{ key: string; message: string }[]>([]);
const folders = computed(() =>
  [...new Set((settings.value.clusters ?? []).map((record) => record.folder).filter((f): f is string => !!f))].sort()
);
const cloudDone = (targets: ContextRef[], notes: { key: string; message: string }[] = []) => {
  if (!targets.length) {
    open.value = false;
    return;
  }
  added.value = targets;
  warnings.value = notes;
  go("done");
};

/* ------------------------------------------------------------- drops -- */

let unlisten: UnlistenFn | null = null;
onMounted(async () => {
  try {
    unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      if (!open.value || event.payload.type !== "drop" || !event.payload.paths.length) return;
      if (step.value !== "choose" && step.value !== "paste") return;
      fileMode.value = "copy";
      void loadPreview({ kind: "path", path: event.payload.paths[0]! });
    });
  } catch {
    /* not in Tauri: HTML5 drops on the paste area */
  }
});
onBeforeUnmount(() => unlisten?.());
const onHtmlDrop = async (event: DragEvent) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  event.preventDefault();
  pasted.value = await file.text();
};

/* --------------------------------------------------------------- done -- */

const connect = (target: ContextRef) => {
  switchContext(target.context, target.kubeConfig, "");
  open.value = false;
  router.push("/");
};
const openHub = () => {
  open.value = false;
  router.push({ name: "ClustersHub" });
};

/* (Re)open: start over at the requested method. */
watch(
  () => [open.value, props.method] as const,
  ([isOpen, method]) => {
    if (!isOpen) return;
    history.length = 0;
    error.value = null;
    pasted.value = "";
    rows.value = [];
    added.value = [];
    manual.value = emptyManualForm();
    warnings.value = [];
    if (method === "cloud" || method === "aws") {
      const provider = method === "aws" ? "aws" : props.provider;
      if (provider) {
        cloudProvider.value = provider;
        cloudHeading.value = { title: `Connect ${providerInfo(provider).name}`, description: "" };
        step.value = "cloud";
      } else step.value = "choose";
    } else step.value = method === "file" ? "choose" : method;
    if (method === "file") void pickFile();
  },
  { immediate: true }
);

const title = computed(
  () =>
    ({
      choose: "Add a cluster",
      paste: "Paste a kubeconfig",
      file: "Import a kubeconfig file",
      preview: "Choose the clusters to add",
      manual: "Enter a cluster",
      cloud: cloudHeading.value.title,
      done: added.value.length === 1 ? "Cluster added" : `${added.value.length} clusters added`,
    })[step.value]
);
const STEP_ICONS = { paste: ClipboardPaste, file: FileUp, manual: PencilLine } as const;
const stepIcon = computed(() =>
  step.value === "preview" ? (source.value?.kind === "path" ? FileUp : ClipboardPaste) : STEP_ICONS[step.value as keyof typeof STEP_ICONS]
);

const OPTIONS = [
  { step: "paste", icon: ClipboardPaste, title: "Paste a kubeconfig", text: "From a colleague, a dashboard or a cloud console" },
  { step: "file", icon: FileUp, title: "Import a kubeconfig file", text: "Copy its clusters in, or use the file where it is" },
  { step: "manual", icon: PencilLine, title: "Enter a cluster", text: "An API server with a token or a client certificate" },
] as const;
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      :class="WIZARD_DIALOG"
      @open-auto-focus="(event: Event) => step === 'choose' && event.preventDefault()"
      @drop.prevent="onHtmlDrop"
      @dragover.prevent
    >
      <WizardHeader :title="title" :tone="step === 'done' ? 'success' : 'default'">
        <template v-if="step !== 'choose'" #icon>
          <ProviderMark v-if="step === 'cloud'" :provider="cloudProvider" :size="22" />
          <Check v-else-if="step === 'done'" class="h-5 w-5" :stroke-width="2.25" />
          <component :is="stepIcon" v-else class="h-[18px] w-[18px]" />
        </template>
        <template #description>
          <template v-if="step === 'choose'">
            <span title="~/.kube/jet-pilot/config">Kept in JET Pilot's own kubeconfig, with credentials in your keychain.</span>
          </template>
          <template v-else-if="step === 'paste'">From a colleague, a dashboard or a cloud console.</template>
          <template v-else-if="step === 'preview'">
            {{ rows.length }} {{ rows.length === 1 ? "context" : "contexts" }}
            <template v-if="sourcePath">
              in <span class="font-mono text-xs text-foreground/80" :title="source?.kind === 'path' ? source.path : undefined">{{ sourcePath }}</span>
            </template>
            <template v-else>in the pasted kubeconfig</template>
          </template>
          <template v-else-if="step === 'manual'">An API server with a token or a client certificate.</template>
          <template v-else-if="step === 'cloud'">{{ cloudHeading.description }}</template>
          <template v-else-if="step === 'done'">Ready in JET Pilot and in your terminal.</template>
        </template>
      </WizardHeader>

      <!-- Cloud: its own body and footer -->
      <AwsConnect
        v-if="step === 'cloud' && cloudProvider === 'aws'"
        :connection-id="connectionId"
        :folders="folders"
        @back="back"
        @done="cloudDone"
        @heading="(heading) => (cloudHeading = heading)"
      />
      <CloudConnect
        v-else-if="step === 'cloud'"
        :key="cloudProvider"
        :provider="cloudProvider"
        :connection-id="connectionId"
        :folders="folders"
        @back="back"
        @done="cloudDone"
        @heading="(heading) => (cloudHeading = heading)"
      />

      <template v-else>
        <div :class="WIZARD_BODY">
          <!-- Choose -->
          <div v-if="step === 'choose'" class="space-y-6">
            <section class="space-y-2.5">
              <h3 :class="WIZARD_GROUP_LABEL">From a cloud account</h3>
              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="cloud in CLOUD_PROVIDERS"
                  :key="cloud.id"
                  type="button"
                  class="group flex min-w-0 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left shadow-xs transition-[border-color,box-shadow,background-color] duration-fast hover:border-border-strong hover:shadow-sm focus-ring"
                  :title="cloud.blurb"
                  @click="chooseCloud(cloud.id)"
                >
                  <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-1 ring-1 ring-inset ring-border/60">
                    <ProviderMark :provider="cloud.id" :size="18" />
                  </span>
                  <span class="min-w-0">
                    <span class="block truncate text-sm font-medium text-foreground">{{ cloud.short }}</span>
                    <span class="block truncate text-xs text-muted-foreground">{{ cloud.product }}</span>
                  </span>
                </button>
              </div>
            </section>

            <section class="space-y-1.5">
              <h3 :class="WIZARD_GROUP_LABEL">From a kubeconfig or by hand</h3>
              <div :class="WIZARD_LIST">
                <button
                  v-for="option in OPTIONS"
                  :key="option.step"
                  type="button"
                  class="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-fast hover:bg-accent/50 focus-ring"
                  @click="option.step === 'file' ? pickFile() : go(option.step)"
                >
                  <span
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors duration-fast group-hover:text-foreground"
                  >
                    <component :is="option.icon" class="h-4 w-4" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium text-foreground">{{ option.title }}</span>
                    <span class="block truncate text-xs text-muted-foreground">{{ option.text }}</span>
                  </span>
                  <ChevronRight
                    class="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover:opacity-100"
                  />
                </button>
              </div>
            </section>
          </div>

          <!-- Paste -->
          <div v-else-if="step === 'paste'" class="space-y-2">
            <Textarea
              v-model="pasted"
              rows="13"
              class="resize-none bg-muted/40 font-mono text-2xs leading-4"
              placeholder="apiVersion: v1&#10;kind: Config&#10;clusters:&#10;- name: …"
              spellcheck="false"
              aria-label="Kubeconfig"
            />
            <p class="text-xs text-muted-foreground">You can also drop a kubeconfig file onto this window.</p>
          </div>

          <!-- Preview -->
          <div v-else-if="step === 'preview'" class="space-y-5">
            <div v-if="source?.kind === 'path'" class="space-y-2">
              <Tabs v-model="fileMode">
                <TabsList aria-label="How to add the file" class="w-full">
                  <TabsTrigger value="copy" class="flex-1">Copy into JET Pilot</TabsTrigger>
                  <TabsTrigger value="reference" class="flex-1">Use the file where it is</TabsTrigger>
                </TabsList>
              </Tabs>
              <p class="text-xs text-muted-foreground">
                {{
                  fileMode === "copy"
                    ? "Credentials move to your keychain; you can delete the file afterwards."
                    : "JET Pilot reads it in place and picks up its changes. Nothing is copied."
                }}
              </p>
            </div>
            <ImportPreview v-if="!referencing" v-model:trusted="trusted" :rows="rows" />
            <div v-else :class="WIZARD_LIST">
              <div v-for="row in rows" :key="row.context.name" class="flex h-10 items-center gap-3 rounded-lg px-3">
                <span class="min-w-0 flex-1 truncate text-sm">{{ row.context.name }}</span>
                <span v-if="row.context.duplicateOf" class="text-xs text-muted-foreground">Already added</span>
              </div>
            </div>
          </div>

          <!-- Manual -->
          <ManualEntry v-else-if="step === 'manual'" v-model="manual" @valid="(ok) => (manualValid = ok)" />

          <!-- Done -->
          <div v-else-if="step === 'done'" :class="WIZARD_LIST">
            <p
              v-for="note in [...new Set(warnings.map((w) => w.message))]"
              :key="note"
              class="mx-3 mb-2 flex items-start gap-2 rounded-lg bg-warning/[0.07] px-3 py-2.5 text-xs text-warning"
            >
              <TriangleAlert class="mt-px h-3.5 w-3.5 shrink-0" /> {{ note }}
            </p>
            <div
              v-for="target in added"
              :key="target.kubeConfig + target.context"
              class="group/row flex h-12 items-center gap-3 rounded-lg px-3 transition-colors duration-fast hover:bg-accent/50"
            >
              <ClusterLabel :context="target.context" :kube-config="target.kubeConfig" size="default" class="text-sm font-medium" />
              <Button
                v-if="added.length > 1"
                size="sm"
                variant="outline"
                class="ml-auto h-7 opacity-0 transition-opacity duration-fast focus-visible:opacity-100 group-hover/row:opacity-100"
                @click="connect(target)"
              >
                Connect
              </Button>
            </div>
          </div>

          <p v-if="error" :class="[WIZARD_ERROR, 'mt-4']" role="alert">
            <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" /> {{ error }}
          </p>
        </div>

        <WizardFooter>
          <template #start>
            <Button v-if="step !== 'choose' && step !== 'done'" variant="ghost" class="-ml-2.5" @click="back">
              <ArrowLeft class="h-3.5 w-3.5" /> Back
            </Button>
            <p v-else-if="step === 'choose'" class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Terminal class="h-3.5 w-3.5 shrink-0" />
              <span class="truncate">Clusters you add work in your terminal too.</span>
            </p>
            <Button v-else variant="ghost" class="-ml-2.5 text-muted-foreground" @click="openHub">Open the Clusters hub</Button>
          </template>

          <Button v-if="step === 'paste'" :disabled="!pasted.trim() || busy" @click="loadPreview({ kind: 'text', text: pasted })">
            <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Continue
          </Button>
          <Button v-else-if="step === 'preview'" :disabled="!canImport || busy" @click="runImport">
            <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
            {{ referencing ? "Use this file" : `Add ${included.length} ${included.length === 1 ? "cluster" : "clusters"}` }}
          </Button>
          <Button v-else-if="step === 'manual'" :disabled="!manualValid || busy" @click="runManual">
            <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Add cluster
          </Button>
          <template v-else-if="step === 'done'">
            <template v-if="added.length === 1">
              <Button variant="outline" @click="open = false">Done</Button>
              <Button @click="connect(added[0]!)">Connect</Button>
            </template>
            <Button v-else @click="open = false">Done</Button>
          </template>
        </WizardFooter>
      </template>
    </DialogContent>
  </Dialog>
</template>
