<script setup lang="ts">
/*
 * Add a cluster: connect a cloud account (AwsConnect), paste (or drop) a
 * kubeconfig, import a kubeconfig file, or enter a cluster by hand. Added
 * clusters go into JET Pilot's own kubeconfig (~/.kube/jet-pilot/config)
 * with their credentials in the system keychain; a file can also be used
 * where it is.
 */
import { useRouter } from "vue-router";
import { homeDir, join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardPaste,
  FileUp,
  KeyRound,
  Loader2,
  PencilLine,
  ServerCog,
} from "lucide-vue-next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import ClusterLabel from "@/components/clusters/ClusterLabel.vue";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import ImportPreview from "./ImportPreview.vue";
import ManualEntry from "./ManualEntry.vue";
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

const AwsConnect = defineAsyncComponent(() => import("./AwsConnect.vue"));

const props = defineProps<{ method: AddMethod; connectionId?: string | null }>();
const open = defineModel<boolean>("open", { required: true });

const router = useRouter();
const { settings } = injectStrict(SettingsContextStateKey);
const switchContext = injectStrict(KubeContextSwitchContextKey);

type Step = "choose" | "paste" | "file" | "preview" | "manual" | "aws" | "done";
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
const canImport = computed(
  () =>
    (fileMode.value === "reference" && source.value?.kind === "path") ||
    (included.value.length > 0 && included.value.every((row) => row.name.trim()) && (!needsTrust.value || trusted.value))
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

const cloudTitle = ref("Connect AWS");
const folders = computed(() =>
  [...new Set((settings.value.clusters ?? []).map((record) => record.folder).filter((f): f is string => !!f))].sort()
);
const cloudDone = (targets: ContextRef[]) => {
  if (!targets.length) {
    open.value = false;
    return;
  }
  added.value = targets;
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
    step.value = method === "file" ? "choose" : method;
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
      aws: cloudTitle.value,
      done: added.value.length === 1 ? "Cluster added" : `${added.value.length} clusters added`,
    })[step.value]
);
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[90vh] max-w-2xl overflow-y-auto" @drop.prevent="onHtmlDrop" @dragover.prevent>
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="step === 'choose'">
          JET Pilot keeps clusters you add in its own kubeconfig (~/.kube/jet-pilot/config) and their credentials in
          your system keychain. Your own kubeconfig isn't changed.
        </DialogDescription>
        <DialogDescription v-else-if="step === 'preview'">
          {{ rows.length }} {{ rows.length === 1 ? "context" : "contexts" }} found. Rename any to avoid clashes.
        </DialogDescription>
      </DialogHeader>

      <!-- Choose -->
      <div v-if="step === 'choose'" class="grid gap-2">
        <p class="text-xs font-medium text-muted-foreground">From a cloud account</p>
        <button
          type="button"
          class="flex items-start gap-3 rounded-lg border bg-card p-3.5 text-left transition-colors duration-fast hover:border-border-strong hover:bg-accent/40 focus-ring"
          @click="go('aws')"
        >
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-1">
            <ProviderMark provider="aws" :size="20" />
          </span>
          <span class="space-y-0.5">
            <span class="block text-sm font-medium">Amazon EKS</span>
            <span class="block text-xs text-muted-foreground">
              Sign in with IAM Identity Center, an AWS profile or access keys, and pick clusters from every account and
              region.
            </span>
          </span>
        </button>
        <p class="pt-2 text-xs font-medium text-muted-foreground">From a kubeconfig, or by hand</p>
        <button
          v-for="option in [
            { step: 'paste', icon: ClipboardPaste, title: 'Paste a kubeconfig', text: 'From a colleague, a dashboard or a cloud console. You can also drop a file here.' },
            { step: 'file', icon: FileUp, title: 'Import a kubeconfig file', text: 'Copy its clusters into JET Pilot, or keep using the file where it is.' },
            { step: 'manual', icon: PencilLine, title: 'Enter a cluster', text: 'An API server address with a token or a client certificate.' },
          ]"
          :key="option.step"
          type="button"
          class="flex items-start gap-3 rounded-lg border bg-card p-3.5 text-left transition-colors duration-fast hover:border-border-strong hover:bg-accent/40 focus-ring"
          @click="option.step === 'file' ? pickFile() : go(option.step as Step)"
        >
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <component :is="option.icon" class="h-4 w-4" />
          </span>
          <span class="space-y-0.5">
            <span class="block text-sm font-medium">{{ option.title }}</span>
            <span class="block text-xs text-muted-foreground">{{ option.text }}</span>
          </span>
        </button>
        <p class="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
          <KeyRound class="h-3.5 w-3.5" /> Clusters you add work in your own terminal too, through JET Pilot's credential helper.
        </p>
      </div>

      <!-- Paste -->
      <div v-else-if="step === 'paste'" class="space-y-2">
        <Textarea
          v-model="pasted"
          rows="12"
          class="font-mono text-2xs"
          placeholder="apiVersion: v1&#10;kind: Config&#10;clusters:&#10;- name: …"
          spellcheck="false"
          aria-label="Kubeconfig"
        />
        <p class="text-xs text-muted-foreground">Or drop a kubeconfig file onto this window.</p>
      </div>

      <!-- Preview -->
      <div v-else-if="step === 'preview'" class="space-y-3">
        <div v-if="source?.kind === 'path'" class="space-y-2 rounded-lg border p-3">
          <p class="truncate font-mono text-2xs text-muted-foreground" :title="source.path">{{ source.path }}</p>
          <label class="flex items-start gap-2 text-sm">
            <input v-model="fileMode" type="radio" value="copy" class="mt-1 accent-[hsl(var(--primary))]" />
            <span>
              <span class="block font-medium">Copy into JET Pilot</span>
              <span class="block text-xs text-muted-foreground">Credentials move to your keychain; the file can go.</span>
            </span>
          </label>
          <label class="flex items-start gap-2 text-sm">
            <input v-model="fileMode" type="radio" value="reference" class="mt-1 accent-[hsl(var(--primary))]" />
            <span>
              <span class="block font-medium">Keep using the file where it is</span>
              <span class="block text-xs text-muted-foreground">JET Pilot reads it and picks up changes; nothing is copied.</span>
            </span>
          </label>
        </div>
        <ImportPreview v-if="!(source?.kind === 'path' && fileMode === 'reference')" v-model:trusted="trusted" :rows="rows" />
      </div>

      <!-- Cloud -->
      <AwsConnect
        v-else-if="step === 'aws'"
        :connection-id="connectionId"
        :folders="folders"
        @back="back"
        @done="cloudDone"
        @title="(text: string) => (cloudTitle = text)"
      />

      <!-- Manual -->
      <ManualEntry v-else-if="step === 'manual'" v-model="manual" @valid="(ok) => (manualValid = ok)" />

      <!-- Done -->
      <div v-else-if="step === 'done'" class="space-y-3">
        <p class="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 class="h-4 w-4" /> Ready to use in JET Pilot and in your terminal.
        </p>
        <ul class="divide-y divide-border-subtle rounded-lg border">
          <li v-for="target in added" :key="target.kubeConfig + target.context" class="flex items-center gap-3 px-3 py-2">
            <ClusterLabel :context="target.context" :kube-config="target.kubeConfig" />
            <Button size="sm" variant="outline" class="ml-auto" @click="connect(target)">Connect</Button>
          </li>
        </ul>
      </div>

      <p v-if="error && step !== 'aws'" class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
        {{ error }}
      </p>

      <DialogFooter v-if="step !== 'aws'" class="items-center">
        <Button v-if="step !== 'choose' && step !== 'done'" variant="ghost" class="mr-auto" @click="back">
          <ArrowLeft class="h-3.5 w-3.5" /> Back
        </Button>
        <template v-if="step === 'paste'">
          <Button :disabled="!pasted.trim() || busy" @click="loadPreview({ kind: 'text', text: pasted })">
            <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Continue
          </Button>
        </template>
        <template v-else-if="step === 'preview'">
          <Button :disabled="!canImport || busy" @click="runImport">
            <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
            {{
              source?.kind === "path" && fileMode === "reference"
                ? "Use this file"
                : `Add ${included.length} ${included.length === 1 ? "cluster" : "clusters"}`
            }}
          </Button>
        </template>
        <template v-else-if="step === 'manual'">
          <Button :disabled="!manualValid || busy" @click="runManual">
            <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Add cluster
          </Button>
        </template>
        <template v-else-if="step === 'done'">
          <Button variant="outline" @click="openHub"><ServerCog class="h-3.5 w-3.5" /> Open the Clusters hub</Button>
          <Button @click="open = false">Done</Button>
        </template>
        <Button v-else variant="ghost" @click="open = false">Cancel</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
