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
import CloseIcon from "@/assets/icons/close.svg";
import { Check, Copy, FileCode, FileText, ScrollText } from "lucide-vue-next";
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

const actionClass =
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
</script>

<template>
  <ResizablePanel
    v-if="sidePanel !== null"
    :default-size="30"
    class="max-h-screen !overflow-y-auto"
  >
    <div class="bg-background p-4 border-b space-y-3">
      <div class="flex justify-between items-center gap-2">
        <div class="flex items-center space-x-2 min-w-0">
          <NavigationItemIcon
            v-if="sidePanel.icon"
            :key="sidePanel.icon"
            :name="sidePanel.icon"
          />
          <span class="truncate" :title="sidePanel.title">{{
            sidePanel.title
          }}</span>
          <button
            v-if="target"
            type="button"
            class="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="copied ? 'Name copied' : `Copy name ${target.name}`"
            :title="copied ? 'Copied!' : 'Copy name'"
            @click="copyName"
          >
            <Check v-if="copied" class="h-3.5 w-3.5 text-green-600 dark:text-green-500" />
            <Copy v-else class="h-3.5 w-3.5" />
          </button>
          <span class="sr-only" aria-live="polite">{{
            copied ? "Name copied to the clipboard" : ""
          }}</span>
        </div>
        <button
          type="button"
          class="shrink-0 rounded p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Close panel"
          title="Close"
          @click="setSidePanelComponent(null)"
        >
          <CloseIcon class="w-4 h-4" />
        </button>
      </div>
      <template v-if="target">
        <dl
          class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        >
          <div v-if="target.namespace" class="flex gap-1 min-w-0">
            <dt>Namespace</dt>
            <dd class="text-foreground truncate">{{ target.namespace }}</dd>
          </div>
          <div v-if="target.context" class="flex gap-1 min-w-0">
            <dt>Context</dt>
            <dd class="text-foreground truncate" :title="target.kubeConfig">
              {{ target.context }}
            </dd>
          </div>
          <div v-if="age" class="flex gap-1">
            <dt>Age</dt>
            <dd
              class="text-foreground"
              :title="resource?.metadata?.creationTimestamp?.toString()"
            >
              {{ age }}
            </dd>
          </div>
        </dl>
        <div class="flex flex-wrap gap-2">
          <button type="button" :class="actionClass" @click="editYaml">
            <FileCode class="h-3.5 w-3.5" /> Edit YAML
          </button>
          <button type="button" :class="actionClass" @click="describe">
            <FileText class="h-3.5 w-3.5" /> Describe
          </button>
          <button
            v-if="canShowLogs"
            type="button"
            :class="actionClass"
            @click="showLogs"
          >
            <ScrollText class="h-3.5 w-3.5" /> Logs
          </button>
        </div>
      </template>
    </div>
    <component :is="sidePanel.component" v-bind="sidePanel.props" />
  </ResizablePanel>
</template>
