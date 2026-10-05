<script setup lang="ts">
import {
  PanelProviderStateKey,
  PanelProviderSetSidePanelComponentKey,
  PanelProviderAddTabKey,
} from "@/providers/PanelProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict, formatDateTimeDifference } from "@/lib/utils";
import { ResizablePanel } from "@/components/ui/resizable";
import NavigationItemIcon from "@/components/NavigationItemIcon.vue";
import ContextAvatar from "@/components/ContextAvatar.vue";
import { Button } from "@/components/ui/button";
import {
  Check,
  Clock,
  Copy,
  FileCode,
  FileText,
  FolderTree,
  ScrollText,
  X,
} from "lucide-vue-next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useRoute } from "vue-router";
import type { KubernetesObject } from "@kubernetes/client-node";
import { error } from "@/lib/logger";

const route = useRoute();

const { sidePanel } = injectStrict(PanelProviderStateKey);
const setSidePanelComponent = injectStrict(
  PanelProviderSetSidePanelComponentKey
);
const addTab = injectStrict(PanelProviderAddTabKey);
const {
  context: primaryContext,
  kubeConfig: primaryKubeConfig,
} = injectStrict(KubeContextStateKey);

watch(route, () => {
  setSidePanelComponent(null);
});

/* Kinds whose logs `kubectl logs <kind>/<name>` can show. */
const LOGGABLE_KINDS = [
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
];

/* Panel resources from the tables carry the context they were fetched from. */
type PanelResource = KubernetesObject & {
  metadata?: KubernetesObject["metadata"] & {
    context?: string;
    kubeConfig?: string;
  };
};

const resource = computed<PanelResource | null>(() => {
  const candidate = sidePanel.value?.props?.resource;
  return candidate?.kind && candidate?.metadata?.name ? candidate : null;
});

const target = computed(() => {
  const object = resource.value;
  if (!object) return null;

  // kind.group disambiguates kinds that exist in several API groups.
  const apiVersion = object.apiVersion || "";
  const group = apiVersion.includes("/") ? apiVersion.split("/")[0] : "";
  const kind = object.kind as string;

  return {
    kind,
    type: group ? `${kind.toLowerCase()}.${group}` : kind,
    name: object.metadata!.name as string,
    namespace: object.metadata?.namespace || "",
    context: object.metadata?.context || primaryContext.value,
    kubeConfig: object.metadata?.kubeConfig || primaryKubeConfig.value,
  };
});

const age = computed(() => {
  const created = resource.value?.metadata?.creationTimestamp;
  if (!created) return null;
  return formatDateTimeDifference(new Date(created), new Date());
});

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const copyName = async () => {
  if (!target.value) return;
  try {
    await writeText(target.value.name);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1500);
  } catch (e) {
    error(`Failed to copy to the clipboard: ${e}`);
  }
};

onUnmounted(() => clearTimeout(copiedTimer));

const tabId = (action: string) => {
  const t = target.value!;
  return [action, t.context, t.namespace, t.type, t.name].join("_");
};

const editYaml = () => {
  const t = target.value!;
  addTab(
    tabId("edit"),
    t.name,
    defineAsyncComponent(() => import("@/views/ObjectEditor.vue")),
    {
      context: t.context,
      namespace: t.namespace,
      kubeConfig: t.kubeConfig,
      type: t.type,
      name: t.name,
      useKubeCtl: true,
    },
    "edit"
  );
};

const describe = () => {
  const t = target.value!;
  addTab(
    tabId("describe"),
    t.name,
    defineAsyncComponent(() => import("@/views/Describe.vue")),
    {
      context: t.context,
      namespace: t.namespace,
      kubeConfig: t.kubeConfig,
      type: t.type,
      name: t.name,
    },
    "describe"
  );
};

const canShowLogs = computed(
  () => !!target.value && LOGGABLE_KINDS.includes(target.value.kind)
);

const showLogs = () => {
  const t = target.value!;
  addTab(
    tabId("logs"),
    t.name,
    defineAsyncComponent(() => import("@/views/StructuredLogViewer.vue")),
    {
      context: t.context,
      namespace: t.namespace,
      kubeConfig: t.kubeConfig,
      object: t.kind === "Pod" ? t.name : `${t.kind.toLowerCase()}/${t.name}`,
    },
    "logs"
  );
};

</script>

<template>
  <ResizablePanel
    v-if="sidePanel !== null"
    :default-size="30"
    data-keyboard-scope="side-panel"
    class="max-h-screen !overflow-y-auto bg-card"
  >
    <div
      class="sticky top-0 z-10 space-y-3 border-b bg-card/95 px-4 pb-3 pt-3.5 backdrop-blur-sm supports-[backdrop-filter]:bg-card/85"
    >
      <div class="flex items-start gap-3">
        <span
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-surface-1 text-muted-foreground shadow-xs"
        >
          <NavigationItemIcon
            v-if="sidePanel.icon"
            :key="sidePanel.icon"
            :name="sidePanel.icon"
            class="h-[18px] w-[18px]"
          />
        </span>
        <div class="min-w-0 flex-1">
          <div
            v-if="target"
            class="text-xs font-medium text-muted-foreground"
          >
            {{ target.kind }}
          </div>
          <div class="flex min-w-0 items-center gap-1">
            <h2
              class="truncate text-base font-semibold leading-6 text-foreground select-text"
              :title="target ? target.name : sidePanel.title"
            >
              {{ target ? target.name : sidePanel.title }}
            </h2>
            <button
              v-if="target"
              type="button"
              class="shrink-0 rounded p-1 text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground focus-ring focus-visible:ring-offset-card"
              :aria-label="copied ? 'Name copied' : `Copy name ${target.name}`"
              :title="copied ? 'Copied!' : 'Copy name'"
              @click="copyName"
            >
              <Check v-if="copied" class="h-3.5 w-3.5 text-success" />
              <Copy v-else class="h-3.5 w-3.5" />
            </button>
            <span class="sr-only" aria-live="polite">{{
              copied ? "Name copied to the clipboard" : ""
            }}</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          class="-mr-1.5 -mt-0.5 shrink-0 text-muted-foreground"
          aria-label="Close panel"
          title="Close"
          @click="setSidePanelComponent(null)"
        >
          <X class="h-4 w-4" />
        </Button>
      </div>
      <template v-if="target">
        <!-- Quiet facts: namespace, cluster, age -->
        <dl
          class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
        >
          <div v-if="target.namespace" class="flex min-w-0 items-center gap-1.5">
            <dt class="sr-only">Namespace</dt>
            <FolderTree class="h-3 w-3 shrink-0" />
            <dd class="truncate">{{ target.namespace }}</dd>
          </div>
          <div v-if="target.context" class="flex min-w-0 items-center gap-1.5">
            <dt class="sr-only">Context</dt>
            <ContextAvatar
              :name="target.context"
              size="sm"
              class="h-4 w-4 text-[9px]"
            />
            <dd class="truncate" :title="target.kubeConfig">
              {{ target.context }}
            </dd>
          </div>
          <div v-if="age" class="flex items-center gap-1.5">
            <dt class="sr-only">Age</dt>
            <Clock class="h-3 w-3 shrink-0" />
            <dd
              class="tabular-nums"
              :title="resource?.metadata?.creationTimestamp?.toString()"
            >
              {{ age }}
            </dd>
          </div>
        </dl>
        <div class="flex flex-wrap gap-1.5">
          <Button variant="outline" size="xs" @click="editYaml">
            <FileCode class="h-3 w-3" /> Edit YAML
          </Button>
          <Button variant="outline" size="xs" @click="describe">
            <FileText class="h-3 w-3" /> Describe
          </Button>
          <Button
            v-if="canShowLogs"
            variant="outline"
            size="xs"
            @click="showLogs"
          >
            <ScrollText class="h-3 w-3" /> Logs
          </Button>
        </div>
      </template>
    </div>
    <component :is="sidePanel.component" v-bind="sidePanel.props" />
  </ResizablePanel>
</template>
